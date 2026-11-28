"""
Mastering A/B on the production benchmark's songs: the delivery chain as it
runs today against the same chain with loudness set by one gain and a
limiter. Measured, not listened to (product owner, 2026-11-28).

Why: the first quality report found choruses barely above their verses
(chorus lift ~0.7-1.2 dB, reference 1-5) and a narrow loudness range (LRA
~3.2 LU, reference 3-10). Today's master ends in single-pass `loudnorm`,
which is its dynamic mode: a gain that follows the music over ~3 s windows.
On a test signal with a chorus 6 dB above its verse it left 2.9 dB.
`mastering.build_linear_filters` keeps the same EQ, compressor and fades and
replaces only that step. Whether that is better on real songs is what this
measures.

The bench's renders were mastered and their WAVs deleted, so each entry is
rendered once more (same request and seed) and the WAV kept under
`master_ab/raw/`. Both arms are made from that one WAV; nothing else differs.

Measured on each arm, with the song's sections placed once (on today's
master) so a difference cannot come from Whisper placing a line elsewhere:

  chorus_lift_db       chorus minus verse level          (reference 1-5 dB)
  lra                  loudness range                     (reference 3-10 LU)
  lufs, true_peak_db   delivery loudness and ceiling      (-15.5..-12.5; <= -1)
  intelligibility      Whisper on the full mix, no stem   (higher is clearer)

`intelligibility` is the one measure that owes nothing to the sections or
to the vocal stem: it asks whether the words come through the mix as heard.

Run on the DGX (same mounts as bench_production.py):

    docker compose run --rm -v "$PWD/server:/opt/server" -v "$PWD/bench_out:/bench" music \\
        python /opt/server/bench_master.py run [--only=zh-pop,ja-ballad]

Resumable. Writes bench_out/production/master_ab/master_ab.json and .html.
"""
from __future__ import annotations

import html
import json
import subprocess
import sys
from pathlib import Path
from typing import Callable, Dict, List, Optional

import numpy as np

import bench_production as bp
import bench_quality as bq
import mastering
import quality_metrics as qm

TARGET_LUFS = -14.0
# Sample-peak ceiling for the limiter. The MP3 encode adds inter-sample peaks;
# today's chain asks for -2.5 dBTP, and the report checks what came out.
CEILING_DB = -3.0
ARMS = ("current", "linear")
COMPARED = ("chorus_lift_db", "lra", "lufs", "true_peak_db", "intelligibility")
HIGHER_IS_BETTER = {"chorus_lift_db": True, "lra": True, "intelligibility": True}


# ------------------------------------------------------------------ the arms
def ffmpeg_master(src: Path, dst: Path, filters: List[str], want_seconds: float, bitrate: str = "192k") -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-af", ",".join(filters),
                    "-t", f"{want_seconds:.3f}", "-codec:a", "libmp3lame", "-b:a", bitrate, "-ar", "44100", str(dst)],
                   check=True)


def make_arms(wav: Path, outdir: Path, entry_id: str, want_seconds: float, *, tone: str, fade_in_ms: int,
              fade_out_ms: int, master_tp: float, master_lra: float,
              lufs_of: Callable[[Path], Optional[float]]) -> Dict[str, dict]:
    """Both masters of one WAV. Returns what each applied."""
    current = outdir / "current" / f"{entry_id}.mp3"
    linear = outdir / "linear" / f"{entry_id}.mp3"
    ffmpeg_master(wav, current, mastering.build_filters(
        tone=tone, lufs=TARGET_LUFS, true_peak=master_tp, lra=master_lra,
        fade_in_ms=fade_in_ms, fade_out_ms=fade_out_ms, want_seconds=want_seconds), want_seconds)

    probe = outdir / "linear" / f".{entry_id}.probe.mp3"

    def lufs_after(gain: float) -> Optional[float]:
        ffmpeg_master(wav, probe, mastering.build_linear_filters(
            tone=tone, gain_db=gain, ceiling_db=CEILING_DB, fade_in_ms=fade_in_ms,
            fade_out_ms=fade_out_ms, want_seconds=want_seconds), want_seconds)
        return lufs_of(probe)

    toned = outdir / "linear" / f".{entry_id}.tone.mp3"
    ffmpeg_master(wav, toned, mastering.tone_filters(tone) or ["anull"], want_seconds)
    start = TARGET_LUFS - (lufs_of(toned) or TARGET_LUFS)
    gain = mastering.fit_gain(lufs_after, TARGET_LUFS, start)
    ffmpeg_master(wav, linear, mastering.build_linear_filters(
        tone=tone, gain_db=gain, ceiling_db=CEILING_DB, fade_in_ms=fade_in_ms,
        fade_out_ms=fade_out_ms, want_seconds=want_seconds), want_seconds)
    for p in (probe, toned):
        p.unlink(missing_ok=True)
    return {"current": {"audio": str(current)}, "linear": {"audio": str(linear), "gain_db": round(gain, 2)}}


# ------------------------------------------------------------- the measures
def chorus_lift(mono: np.ndarray, sr: int, sections: List[dict]) -> Optional[float]:
    """Chorus minus verse, mean frame level in dB, over sections of at least 2 s (as bench_quality)."""
    hop = 512
    frames = mono[: mono.size // hop * hop].reshape(-1, hop)
    rms_db = 20 * np.log10(np.maximum(np.sqrt(np.mean(frames ** 2, axis=1)), 1e-9))
    hop_s = hop / sr

    def mean(name: str) -> Optional[float]:
        vals = [rms_db[int(s["start"] / hop_s):int(s["end"] / hop_s)] for s in sections
                if s["name"] == name and s["end"] - s["start"] >= 2.0]
        vals = [v for v in vals if v.size]
        return float(np.mean(np.concatenate(vals))) if vals else None

    c, v = mean("chorus"), mean("verse")
    return None if c is None or v is None else round(c - v, 2)


def measure_arm(path: Path, sections: List[dict], lyrics: str, *, decode: Callable[[Path], np.ndarray],
                loudness: Callable[[Path], dict], intelligibility: Callable[[Path, str], float]) -> dict:
    ld = loudness(path)
    return {"chorus_lift_db": chorus_lift(decode(path), 44100, sections), "lra": ld.get("lra"),
            "lufs": ld.get("lufs"), "true_peak_db": ld.get("true_peak_db"),
            "intelligibility": round(float(intelligibility(path, lyrics)), 3)}


# ---------------------------------------------------------------- the report
def in_band(metric: str, value: Optional[float]) -> Optional[bool]:
    ref = bq.REFERENCE.get(metric)
    if ref is None or value is None:
        return None
    lo, hi, _ = ref
    return (lo is None or value >= lo) and (hi is None or value <= hi)


def summarise(rows: Dict[str, dict]) -> dict:
    """Per measure: median of current, linear and linear − current; how often linear is higher; in-band counts."""
    done = {i: r for i, r in rows.items() if all(a in r for a in ARMS)}
    out: Dict[str, dict] = {}
    for m in COMPARED:
        cur = [done[i]["current"].get(m) for i in sorted(done)]
        lin = [done[i]["linear"].get(m) for i in sorted(done)]
        deltas = [None if a is None or b is None else round(b - a, 3) for a, b in zip(cur, lin)]
        med = lambda xs: (round(float(np.median([x for x in xs if x is not None])), 3)  # noqa: E731
                          if any(x is not None for x in xs) else None)
        out[m] = {"current": med(cur), "linear": med(lin), "delta": med(deltas), **qm.sign_test(deltas),
                  "in_band_current": sum(1 for x in cur if in_band(m, x)),
                  "in_band_linear": sum(1 for x in lin if in_band(m, x)),
                  "n_with_band": sum(1 for x in cur if in_band(m, x) is not None)}
    return {"songs": len(done), "measures": out}


LABELS = {"chorus_lift_db": "副歌比主歌（dB）", "lra": "响度范围 LRA（LU）", "lufs": "整体响度（LUFS）",
          "true_peak_db": "真峰值（dBTP）", "intelligibility": "完整混音里能听清的歌词比例"}


def page(summary: dict) -> str:
    rows = []
    for m, s in summary["measures"].items():
        ref = bq.REFERENCE.get(m)
        band = "—" if not ref else ref[2]
        inb = f"{s['in_band_current']} → {s['in_band_linear']} / {s['n_with_band']}" if s["n_with_band"] else "—"
        rows.append(f"<tr><td>{html.escape(LABELS[m])}</td><td>{s['current']}</td><td>{s['linear']}</td>"
                    f"<td>{s['delta']}</td><td>{s['b_higher']} / {s['b_lower']}</td><td>{s['p']}</td>"
                    f"<td>{inb}</td><td class=muted>{html.escape(band)}</td></tr>")
    return f"""<!doctype html><html lang=zh-CN><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>母带对比</title><style>body{{font:15px/1.6 system-ui,sans-serif;max-width:960px;margin:24px auto;padding:0 16px;color:#222}}
table{{border-collapse:collapse;width:100%}}td,th{{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left}}.muted{{color:#777;font-size:13px}}</style>
<h1>母带对比：现在的链路 vs 增益 + 限幅器</h1>
<p>{summary['songs']} 首歌，每首由同一个 WAV 做出两个版本，只有响度那一步不同。数字是中位数。</p>
<table><tr><th>指标</th><th>现在</th><th>增益+限幅</th><th>差（后−前）</th><th>升 / 降</th><th>p</th><th>在参考范围内（前→后）</th><th>参考</th></tr>
{''.join(rows)}</table>
<p class=muted>p 为符号检验。“能听清的歌词比例”是 Whisper 直接听完整混音，不经人声分离，也不依赖段落划分。</p>
"""


# ----------------------------------------------------------------------- main
def main(argv: List[str]) -> None:
    cmd = argv[1] if len(argv) > 1 else "run"
    if cmd != "run":
        raise SystemExit(f"unknown command {cmd!r}: run [--only=brief,brief]")
    only = next((a.split("=", 1)[1].split(",") for a in argv if a.startswith("--only=")), None)
    import app
    import separate
    manifest = bp.load_manifest()
    out = bp.OUT / "master_ab"
    store = out / "master_ab.json"
    rows: Dict[str, dict] = json.loads(store.read_text(encoding="utf-8")) if store.exists() else {}
    entries = [e for e in manifest["entries"] if not only or e["brief"] in only]
    todo = [e for e in entries if not all(a in rows.get(e["id"], {}) for a in ARMS)]
    print(f"{len(entries) - len(todo)} done, {len(todo)} to do", flush=True)
    app.get_whisper()
    lufs_of = lambda p: bq.ebur128(p).get("lufs")  # noqa: E731
    decode = lambda p: separate.decode(p, 44100, 2).mean(axis=0)  # noqa: E731
    for n, e in enumerate(todo, 1):
        row = rows.setdefault(e["id"], {})
        row.pop("error", None)
        try:
            wav = out / "raw" / f"{e['id']}.wav"
            if not wav.exists():
                work = out / "tmp" / e["id"]
                made = app.render(e["request"], work, seed=e["seed"], tag_style="v2")
                wav.parent.mkdir(parents=True, exist_ok=True)
                made.replace(wav)
                subprocess.run(["rm", "-rf", str(work)], check=False)
            want = app._probe_seconds(wav)
            arms = make_arms(wav, out, e["id"], want, tone=app.MASTER_TONE, fade_in_ms=app.FADE_IN_MS,
                             fade_out_ms=app.FADE_OUT_MS, master_tp=app.MASTER_TP, master_lra=app.MASTER_LRA,
                             lufs_of=lufs_of)
            lyrics = bq.lyrics_of(manifest, e["id"])
            # Sections once, on today's master, so both arms are cut at the same seconds.
            sections = bq.measure(Path(arms["current"]["audio"]), lyrics)["sections"]
            row["sections"] = sections
            for arm in ARMS:
                row[arm] = {**arms[arm], **measure_arm(Path(arms[arm]["audio"]), sections, lyrics, decode=decode,
                                                       loudness=bq.ebur128, intelligibility=app.intelligibility)}
        except Exception as err:  # one bad render is a finding, not the end of the run
            row["error"] = f"{type(err).__name__}: {str(err)[:200]}"
        print(f"[{n}/{len(todo)}] {e['id']}" + (f" — {row['error']}" if "error" in row else ""), flush=True)
        store.parent.mkdir(parents=True, exist_ok=True)
        store.write_text(json.dumps(rows, indent=1, ensure_ascii=False), encoding="utf-8")
    summary = summarise(rows)
    (out / "summary.json").write_text(json.dumps(summary, indent=1, ensure_ascii=False), encoding="utf-8")
    (out / "master_ab.html").write_text(page(summary), encoding="utf-8")
    print(json.dumps(summary, indent=1, ensure_ascii=False))
    print(f"wrote {out / 'master_ab.html'}")


if __name__ == "__main__":
    main(sys.argv)
