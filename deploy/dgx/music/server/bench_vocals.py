"""
Vocal benchmark: is it our code, or the model?

Renders a fixed set of songs under several configurations and scores each
render by *intelligibility* — the share of the lyric characters Whisper hears,
in order — then writes a CSV and an HTML page with every take playable next to
its score, so the numbers can be checked by ear.

Run on the DGX (inside the music image, while the service keeps serving):
    cd ~/yuha-spark && docker compose run --rm -v "$PWD/bench_out:/bench" music \
        python /opt/server/bench_vocals.py            # full run, ~20-30 min
    ... python /opt/server/bench_vocals.py --quick    # 2 songs: v1 baseline vs 1.5 XL turbo, ~3 min
    ... python /opt/server/bench_vocals.py --only=A_baseline,G_v15_xl_sft
Then open bench_out/report.html (scp it to your Mac).
"""
from __future__ import annotations

import csv
import os
import html
import json
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path

import app  # the service module: same render path as production
from align import parse_lyrics

OUT = Path(os.environ.get("BENCH_OUT", "/bench"))
DUR = 60
SEEDS = [11, 22]

# Fixed lyrics, written for a 60-second song: "sparse" is ~1 short line per 6-7s
# with room for an intro; "dense" is what a 4-5s-per-line rule produces.
SONGS = {
    "zh-pop": dict(
        style_tags=["pop", "city pop"], instruments=["electric_piano", "bass", "soft_drums"], tempo="medium", energy=0.5,
        prompt="warm city pop ballad, gentle female vocal, evening streets",
        sparse="[verse]\n路灯把影子拉得很长\n我想起你笑的方向\n[chorus]\n晚风也替我点头\n把那句想你说出口\n[verse]\n城市慢慢安静下来\n我把心事交给夜晚",
        dense="[verse]\n路灯把影子拉得很长\n我想起你笑的方向\n车窗外的霓虹在闪\n像你那天说的谎\n[chorus]\n晚风也替我点头\n把那句想你说出口\n握不住的时间太匆忙\n但我会在原地发光\n[verse]\n城市慢慢安静下来\n我把心事交给夜晚\n耳机里还是那首歌\n唱着我们的过往\n[chorus]\n晚风也替我点头\n把那句想你说出口",
    ),
    "zh-ballad": dict(
        style_tags=["ballad"], instruments=["piano", "strings"], tempo="slow", energy=0.3,
        prompt="slow piano ballad, warm male vocal, nostalgic",
        sparse="[verse]\n旧照片里的夏天\n还停在你的笑脸\n[chorus]\n如果时间能倒回\n我想再说一遍再见\n[verse]\n窗外下着小雨\n我还在等你回来",
        dense="[verse]\n旧照片里的夏天\n还停在你的笑脸\n风吹过空空的街\n我还记得你的眼\n[chorus]\n如果时间能倒回\n我想再说一遍再见\n把所有的不舍得\n都写进这首歌里面\n[verse]\n窗外下着小雨\n我还在等你回来\n门口那盏旧灯\n一直为你亮着\n[chorus]\n如果时间能倒回\n我想再说一遍再见",
    ),
    "ja-pop": dict(
        style_tags=["j-pop"], instruments=["acoustic_guitar", "soft_drums"], tempo="medium", energy=0.55,
        prompt="bright j-pop, clear female vocal, hopeful morning",
        sparse="[verse]\n朝の光が窓を染めて\n新しい一日が始まる\n[chorus]\nきっと大丈夫だよ\n君と歩いていく\n[verse]\n小さな夢を抱いて\n今日も前を向く",
        dense="[verse]\n朝の光が窓を染めて\n新しい一日が始まる\nコーヒーの香りが広がって\n昨日の涙も乾いてく\n[chorus]\nきっと大丈夫だよ\n君と歩いていく\n遠い空の向こうまで\n笑顔を届けたい\n[verse]\n小さな夢を抱いて\n今日も前を向く\n駅までの坂道も\n少しだけ軽くなる\n[chorus]\nきっと大丈夫だよ\n君と歩いていく",
    ),
    "ja-ballad": dict(
        style_tags=["ballad"], instruments=["piano"], tempo="slow", energy=0.3,
        prompt="quiet piano ballad, soft male vocal, winter night",
        sparse="[verse]\n白い息が消えていく\n冬の夜に一人きり\n[chorus]\n会いたいと言えなくて\n星を見上げていた\n[verse]\n遠くで鐘が鳴る\n君の声を思い出す",
        dense="[verse]\n白い息が消えていく\n冬の夜に一人きり\n街の灯りがにじんで\n胸の奥が少し痛い\n[chorus]\n会いたいと言えなくて\n星を見上げていた\n届かない想いだけが\n夜空に溶けていく\n[verse]\n遠くで鐘が鳴る\n君の声を思い出す\nあの日の約束を\nまだ覚えているよ\n[chorus]\n会いたいと言えなくて\n星を見上げていた",
    ),
    "en-pop": dict(
        style_tags=["pop"], instruments=["synth", "drums"], tempo="fast", energy=0.75,
        prompt="upbeat synth pop, confident female vocal, summer night drive",
        sparse="[verse]\nCity lights are calling out my name\nWindows down we never feel the same\n[chorus]\nTonight we run, tonight we shine\nHold my hand, the stars align\n[verse]\nRadio is playing our song\nWe have been waiting for so long",
        dense="[verse]\nCity lights are calling out my name\nWindows down we never feel the same\nEvery corner tells another story\nEvery heartbeat chasing after glory\n[chorus]\nTonight we run, tonight we shine\nHold my hand, the stars align\nNothing stops us, nothing breaks\nThis is all the love it takes\n[verse]\nRadio is playing our song\nWe have been waiting for so long\nSummer air is warm against my skin\nOpen up and let the night begin\n[chorus]\nTonight we run, tonight we shine\nHold my hand, the stars align",
    ),
    "en-folk": dict(
        style_tags=["folk", "acoustic"], instruments=["acoustic_guitar"], tempo="slow", energy=0.3,
        prompt="gentle acoustic folk, warm male vocal, quiet home",
        sparse="[verse]\nMorning coffee on the windowsill\nThe old house is quiet and still\n[chorus]\nStay a little longer here\nLet the slow days disappear\n[verse]\nRain is tapping on the door\nI do not need anything more",
        dense="[verse]\nMorning coffee on the windowsill\nThe old house is quiet and still\nPhotographs along the hallway wall\nRemind me of the summers and the fall\n[chorus]\nStay a little longer here\nLet the slow days disappear\nEvery song we used to sing\nComes back softly in the spring\n[verse]\nRain is tapping on the door\nI do not need anything more\nCandles burning low tonight\nEverything is feeling right\n[chorus]\nStay a little longer here\nLet the slow days disappear",
    ),
}

# name -> (engine, tag_style, lyric_guidance, infer_steps, lyrics_variant, v15_model)
CONFIGS = {
    "A_baseline": ("v1", "v1", 0.0, 60, "sparse", None),
    "B_tags_v2": ("v1", "v2", 0.0, 60, "sparse", None),
    "C_v2_lyricguide": ("v1", "v2", 1.5, 60, "sparse", None),
    "D_v2_steps100": ("v1", "v2", 0.0, 100, "sparse", None),
    "E_v2_dense": ("v1", "v2", 0.0, 60, "dense", None),
    "F_v15_xl_turbo": ("v15", "v2", 0.0, 8, "sparse", "acestep-v15-xl-turbo"),
    "G_v15_xl_sft": ("v15", "v2", 0.0, 50, "sparse", "acestep-v15-xl-sft"),
}


def transcript_text(path: Path, lyrics: str) -> str:
    return "".join(w for w, _, _ in app.transcribe_words(path, lyrics))


def main() -> None:
    quick = "--quick" in sys.argv
    only = [a.split("=", 1)[1].split(",") for a in sys.argv if a.startswith("--only=")]
    songs = dict(list(SONGS.items())[:2]) if quick else SONGS
    names = only[0] if only else (["A_baseline", "F_v15_xl_turbo"] if quick else list(CONFIGS))
    configs = {k: CONFIGS[k] for k in names}
    OUT.mkdir(parents=True, exist_ok=True)
    print("loading models…", flush=True)
    if any(c[0] == "v1" for c in configs.values()):
        app.get_pipeline()
    app.get_whisper()

    rows = []
    total = len(songs) * len(configs) * len(SEEDS)
    n = 0
    for cname, (engine, tag_style, lg, steps, variant, v15_model) in configs.items():
        for sname, song in songs.items():
            lyrics = song[variant]
            req = {**{k: v for k, v in song.items() if k not in ("sparse", "dense")},
                   "duration_seconds": DUR, "instrumental": False, "lyrics": lyrics, "format": "mp3"}
            for seed in SEEDS:
                n += 1
                t0 = time.time()
                work = OUT / "tmp" / f"{cname}-{sname}-{seed}"
                wav = app.render(req, work, seed=seed, tag_style=tag_style, lyric_guidance=lg, infer_steps=steps,
                                 engine=engine, v15_model=v15_model)
                gen_s = time.time() - t0
                mp3 = OUT / cname / f"{sname}-s{seed}.mp3"
                mp3.parent.mkdir(parents=True, exist_ok=True)
                subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-b:a", "192k", str(mp3)], check=True)
                score = app.intelligibility(wav, lyrics)
                heard = transcript_text(wav, lyrics)
                shutil.rmtree(work, ignore_errors=True)
                rows.append(dict(config=cname, song=sname, lang=sname[:2], seed=seed, lines=len(parse_lyrics(lyrics)),
                                 intelligibility=round(score, 3), gen_seconds=round(gen_s, 1),
                                 prompt=app.build_tags(req, tag_style), heard=heard[:300], file=str(mp3.relative_to(OUT))))
                print(f"[{n}/{total}] {cname:16s} {sname:10s} seed={seed} intelligibility={score:.2f} ({gen_s:.0f}s)", flush=True)

    with open(OUT / "results.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    # summary: mean per config, per language, and the best-of-2 effect
    summary = []
    for cname in configs:
        rs = [r for r in rows if r["config"] == cname]
        by_song = {}
        for r in rs:
            by_song.setdefault(r["song"], []).append(r["intelligibility"])
        line = dict(config=cname, mean=round(statistics.mean(r["intelligibility"] for r in rs), 3),
                    best_of_2=round(statistics.mean(max(v) for v in by_song.values()), 3))
        for lang in ("zh", "ja", "en"):
            v = [r["intelligibility"] for r in rs if r["lang"] == lang]
            line[lang] = round(statistics.mean(v), 3) if v else None
        summary.append(line)
    (OUT / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print("\n== summary (intelligibility, higher is better)")
    print(f"{'config':18s} {'mean':>6s} {'best2':>6s} {'zh':>6s} {'ja':>6s} {'en':>6s}")
    for s in summary:
        print(f"{s['config']:18s} {s['mean']:6.2f} {s['best_of_2']:6.2f} " + " ".join(f"{(s[l] if s[l] is not None else float('nan')):6.2f}" for l in ("zh", "ja", "en")))

    # listening page
    def cell(r):
        return (f"<td><audio controls preload='none' src='{html.escape(r['file'])}'></audio>"
                f"<div><b>{r['intelligibility']:.2f}</b> · {r['gen_seconds']}s</div>"
                f"<details><summary>heard</summary>{html.escape(r['heard'])}</details></td>")
    parts = ["<!doctype html><meta charset=utf-8><title>YUHA vocal bench</title>",
             "<style>body{font:14px system-ui;margin:24px}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:8px;vertical-align:top}audio{width:220px}</style>",
             "<h1>YUHA vocal bench</h1><h2>Summary</h2><table><tr><th>config</th><th>mean</th><th>best of 2</th><th>zh</th><th>ja</th><th>en</th></tr>"]
    for s in summary:
        parts.append(f"<tr><td>{s['config']}</td><td>{s['mean']}</td><td>{s['best_of_2']}</td><td>{s['zh']}</td><td>{s['ja']}</td><td>{s['en']}</td></tr>")
    parts.append("</table><h2>Takes</h2><table><tr><th>song</th>" + "".join(f"<th>{c}</th>" for c in configs) + "</tr>")
    for sname in songs:
        for seed in SEEDS:
            parts.append(f"<tr><td>{sname}<br>seed {seed}</td>")
            for cname in configs:
                r = next(x for x in rows if x["config"] == cname and x["song"] == sname and x["seed"] == seed)
                parts.append(cell(r))
            parts.append("</tr>")
    parts.append("</table>")
    (OUT / "report.html").write_text("".join(parts), encoding="utf-8")
    shutil.rmtree(OUT / "tmp", ignore_errors=True)
    print(f"\nreport: {OUT / 'report.html'}")


if __name__ == "__main__":
    main()
