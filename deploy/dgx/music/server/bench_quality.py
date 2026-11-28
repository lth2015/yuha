"""
Production-quality report for the production benchmark's renders — measured,
not listened to (product owner, 2026-11-28: lay blind listening is not a
basis for production decisions).

For each render in bench_out/production it separates the vocal (demucs, as
the lyric sync does), places every lyric line (Whisper + align.align_lines,
as the lyric sync does) so the song's sections are known in seconds, and
measures what a pop producer checks:

  structure   chorus 2 against chorus 1 (with chorus-to-verse as the control);
              the intro's figure inside the chorus melody (with the verse as
              the control); the outro against the intro
  lift        chorus minus verse: level, brightness, note density
  vocal       vocal-to-accompaniment level where it sings; how much of the
              lyric Whisper heard
  loudness    integrated LUFS, loudness range (LRA), true peak (EBU R128)
  time, key   beat-interval variation; share of 8-second windows in the
              song's key
  ending      the closing seconds against the body

Then, per A/B pair, B minus A, and across pairs how often B is higher and
the sign-test p. The reference bands are working values for mainstream
streaming pop, printed next to each number; they are not a standard.

What it cannot tell: whether a hook is memorable, a lyric moving, a voice
beautiful. It reports what can be measured, says so, and nothing more.

Run on the DGX like bench_production.py (same mounts, after its `run`):

    docker compose run --rm -v "$PWD/server:/opt/server" -v "$PWD/bench_out:/bench" music \\
        python /opt/server/bench_quality.py validate   # do the measures catch planted defects?
    ... python /opt/server/bench_quality.py run        # measure the 24 renders, write the report

Writes bench_out/production/quality.json and quality.html.
"""
from __future__ import annotations

import html
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Dict, List, Optional

import numpy as np

import bench_production as bp
import quality_metrics as qm

SR = 22050
HOP = 512
HOP_S = HOP / SR
# Bumped when the tempo measure changes, so `run` re-measures renders read the old way.
TEMPO_METHOD = "halves-acf"
DTW_STEP = 4            # ~93 ms per DTW step
KEY_WINDOW_S = 8.0
MIN_INTRO_S = 3.0
MOTIF_MAX_S = 8.0

# (low, high, what it rests on). None = no bound on that side.
REFERENCE = {
    "lufs": (-15.5, -12.5, "流媒体主流交付约 −14 LUFS"),
    "true_peak_db": (None, -1.0, "主流平台要求真峰值 ≤ −1 dBTP"),
    "lra": (3.0, 10.0, "流行歌 LRA 常见 3–10 LU；过小是压得过死，过大是不稳"),
    "chorus_lift_db": (1.0, 5.0, "副歌通常比主歌高 1–5 dB"),
    "vocal_ratio_db": (-3.0, 8.0, "主流流行人声在前：人声与伴奏电平差约 −3 到 +8 dB"),
    "tempo_drift": (None, 0.03, "后半速度与前半相差不超过 3%"),
    "key_agreement": (0.6, None, "≥60% 的 8 秒窗口与全曲调性一致"),
    "close_minus_body_db": (None, -3.0, "结尾前 4 秒比主体低 ≥3 dB，视为有收束"),
    "lyric_coverage": (0.7, None, "Whisper 能按顺序对上 ≥70% 的歌词字符"),
}


# ------------------------------------------------------------------ measuring
def ebur128(path: Path) -> Dict[str, Optional[float]]:
    p = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128=peak=true", "-f", "null", "-"],
                       capture_output=True, text=True)
    tail = p.stderr[p.stderr.rfind("Summary:"):] if "Summary:" in p.stderr else p.stderr
    grab = lambda pat: (float(m.group(1)) if (m := re.search(pat, tail)) else None)  # noqa: E731
    return {"lufs": grab(r"I:\s*(-?[\d.]+) LUFS"), "lra": grab(r"LRA:\s*([\d.]+) LU"), "true_peak_db": grab(r"Peak:\s*(-?[\d.]+) dBFS")}


def sections_from(alignment: dict, duration: float) -> List[dict]:
    """Consecutive aligned lines of one section become one span; intro and outro are what lies outside."""
    lines = [l for l in alignment.get("lines", []) if l.get("start") is not None and l.get("end") is not None]
    spans: List[dict] = []
    for l in lines:
        name = (l.get("section") or "").lower().strip() or "verse"
        name = "chorus" if "chorus" in name and "pre" not in name else name
        if spans and spans[-1]["name"] == name:
            spans[-1]["end"] = l["end"]
        else:
            spans.append({"name": name, "start": l["start"], "end": l["end"]})
    if lines:
        spans.insert(0, {"name": "intro", "start": 0.0, "end": lines[0]["start"]})
        spans.append({"name": "outro", "start": lines[-1]["end"], "end": duration})
    return spans


def measure(path: Path, lyrics: str) -> dict:
    import librosa
    import align
    import app
    import separate

    out: dict = {"loudness": ebur128(path)}
    mix = separate.decode(path, 44100, 2)
    mono = mix.mean(axis=0)
    duration = mono.size / 44100
    with app._gpu_lock:
        stem = separate.vocal_stem(path)
    vocal = accomp = None
    if stem is not None:
        v, vsr = stem
        if vsr != 44100:
            v = librosa.resample(v, orig_sr=vsr, target_sr=44100)
        n = min(v.size, mono.size)
        vocal, accomp = v[:n], mono[:n] - v[:n]
    words = app.transcribe_words(separate.to_16k(vocal, 44100) if vocal is not None else path, lyrics)
    voiced = align.voiced_intervals(separate.loudness_envelope(vocal, 44100), 0.02) if vocal is not None else None
    al = align.align_lines(lyrics, words, duration, voiced=voiced)
    spans = sections_from(al, duration)
    out["lyric_coverage"] = round(float(al.get("coverage", 0.0)), 3)
    out["sections"] = [{**s, "start": round(s["start"], 2), "end": round(s["end"], 2)} for s in spans]
    out["separated"] = vocal is not None

    rs = lambda x: librosa.resample(x.astype(np.float32), orig_sr=44100, target_sr=SR)  # noqa: E731
    y = rs(mono)
    chroma_mix = librosa.feature.chroma_cqt(y=y, sr=SR, hop_length=HOP)
    chroma_voc = librosa.feature.chroma_cqt(y=rs(vocal), sr=SR, hop_length=HOP) if vocal is not None else None
    rms_db = 20 * np.log10(np.maximum(librosa.feature.rms(y=y, hop_length=HOP)[0], 1e-9))
    centroid = librosa.feature.spectral_centroid(y=y, sr=SR, hop_length=HOP)[0]
    onsets = librosa.onset.onset_detect(y=y, sr=SR, hop_length=HOP, units="time")
    _, beats = librosa.beat.beat_track(y=y, sr=SR, hop_length=HOP, units="time")
    env = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP)
    whole = qm.periodicity_bpm(env, HOP_S)
    halves = (qm.periodicity_bpm(env[: env.size // 2], HOP_S, near=whole), qm.periodicity_bpm(env[env.size // 2:], HOP_S, near=whole))

    f = lambda t: int(round(t / HOP_S))  # noqa: E731
    cut = lambda m, s: m[:, f(s["start"]):f(s["end"])]  # noqa: E731
    ds = lambda m: qm.downsample(m, DTW_STEP)  # noqa: E731
    named = lambda name: [s for s in spans if s["name"] == name and s["end"] - s["start"] >= 2.0]  # noqa: E731
    choruses, verses = named("chorus"), named("verse")
    intro = next((s for s in spans if s["name"] == "intro"), None)
    outro = next((s for s in spans if s["name"] == "outro"), None)

    st: dict = {"choruses": len(choruses), "verses": len(verses),
                "intro_s": round(intro["end"] - intro["start"], 2) if intro else None,
                "outro_s": round(outro["end"] - outro["start"], 2) if outro else None}
    melody = chroma_voc if chroma_voc is not None else chroma_mix
    if len(choruses) >= 2:
        st["chorus_recurrence"] = qm.dtw_similarity(ds(cut(melody, choruses[0])), ds(cut(melody, choruses[1])))
        if verses:
            st["chorus_vs_verse"] = qm.dtw_similarity(ds(cut(melody, choruses[0])), ds(cut(melody, verses[0])))
    if intro and intro["end"] - intro["start"] >= MIN_INTRO_S and choruses:
        start = max(intro["start"], intro["end"] - MOTIF_MAX_S)
        figure = ds(cut(chroma_mix, {"start": start, "end": intro["end"]}))
        st["motif_in_chorus"] = max(filter(None, (qm.best_match(figure, ds(cut(melody, c))) for c in choruses)), default=None)
        if verses:
            st["motif_in_verse"] = max(filter(None, (qm.best_match(figure, ds(cut(melody, v))) for v in verses)), default=None)
    if intro and outro and min(intro["end"] - intro["start"], outro["end"] - outro["start"] - 1.0) >= MIN_INTRO_S:
        st["outro_vs_intro"] = qm.dtw_similarity(ds(cut(chroma_mix, intro)), ds(cut(chroma_mix, {"start": outro["start"], "end": outro["end"] - 1.0})))
    for k in ("chorus_recurrence", "chorus_vs_verse", "motif_in_chorus", "motif_in_verse", "outro_vs_intro"):
        if st.get(k) is not None:
            st[k] = round(st[k], 3)
    if st.get("chorus_recurrence") is not None and st.get("chorus_vs_verse") is not None:
        st["chorus_recurrence_margin"] = round(st["chorus_recurrence"] - st["chorus_vs_verse"], 3)
    if st.get("motif_in_chorus") is not None and st.get("motif_in_verse") is not None:
        st["motif_margin"] = round(st["motif_in_chorus"] - st["motif_in_verse"], 3)
    out["structure"] = st

    def seg_mean(arr, segs):
        vals = [arr[f(s["start"]):f(s["end"])] for s in segs]
        vals = [v for v in vals if v.size]
        return float(np.mean(np.concatenate(vals))) if vals else None

    def onset_rate(segs):
        total = sum(s["end"] - s["start"] for s in segs)
        return sum(1 for t in onsets if any(s["start"] <= t < s["end"] for s in segs)) / total if total > 0 else None

    lift: dict = {}
    if choruses and verses:
        lift["chorus_lift_db"] = round(seg_mean(rms_db, choruses) - seg_mean(rms_db, verses), 2)
        lift["chorus_brightness_ratio"] = round(seg_mean(centroid, choruses) / max(seg_mean(centroid, verses), 1e-9), 3)
        lift["chorus_density_ratio"] = round(onset_rate(choruses) / max(onset_rate(verses) or 1e-9, 1e-9), 3)
    out["lift"] = lift

    voc: dict = {}
    if vocal is not None:
        sung = [s for s in spans if s["name"] not in ("intro", "outro")]
        idx = np.zeros(vocal.size, dtype=bool)
        for s in sung:
            idx[int(s["start"] * 44100):int(s["end"] * 44100)] = True
        if idx.any():
            voc["vocal_ratio_db"] = round(qm.db(np.sqrt(np.mean(vocal[idx] ** 2))) - qm.db(np.sqrt(np.mean(accomp[idx] ** 2))), 2)
    out["vocal"] = voc

    key, agree = qm.key_consistency(chroma_mix, int(round(KEY_WINDOW_S / HOP_S)))
    beat_cv = qm.interval_cv(beats)
    drift = qm.tempo_drift(*halves)
    out["time_key"] = {"key": key, "key_agreement": None if agree is None else round(agree, 2),
                       "beat_cv": None if beat_cv is None else round(beat_cv, 3),
                       "tempo_drift": None if drift is None else round(drift, 3),
                       "tempo_method": TEMPO_METHOD,
                       "tempo_bpm": round(60.0 / float(np.median(np.diff(beats))), 1) if len(beats) > 8 else None}
    out["ending"] = qm.ending(rms_db, HOP_S)
    return out


# ------------------------------------------------------------------- figures
def flat(m: dict) -> Dict[str, Optional[float]]:
    """The numbers the report compares, by name."""
    s, l, v, tk, e, ld = m.get("structure", {}), m.get("lift", {}), m.get("vocal", {}), m.get("time_key", {}), m.get("ending", {}), m.get("loudness", {})
    return {
        "motif_margin": s.get("motif_margin"), "motif_in_chorus": s.get("motif_in_chorus"),
        "chorus_recurrence": s.get("chorus_recurrence"), "chorus_recurrence_margin": s.get("chorus_recurrence_margin"),
        "outro_vs_intro": s.get("outro_vs_intro"), "intro_s": s.get("intro_s"), "outro_s": s.get("outro_s"),
        "chorus_lift_db": l.get("chorus_lift_db"), "chorus_brightness_ratio": l.get("chorus_brightness_ratio"),
        "chorus_density_ratio": l.get("chorus_density_ratio"), "vocal_ratio_db": v.get("vocal_ratio_db"),
        "lyric_coverage": m.get("lyric_coverage"), "lufs": ld.get("lufs"), "lra": ld.get("lra"), "true_peak_db": ld.get("true_peak_db"),
        "tempo_drift": tk.get("tempo_drift"), "key_agreement": tk.get("key_agreement"), "close_minus_body_db": e.get("close_minus_body_db"),
    }


def in_band(name: str, value: Optional[float]) -> Optional[bool]:
    if value is None or name not in REFERENCE:
        return None
    lo, hi, _ = REFERENCE[name]
    return (lo is None or value >= lo) and (hi is None or value <= hi)


# Which way is better for the A/B question; None = a band, not a direction.
BETTER = {"motif_margin": 1, "motif_in_chorus": 1, "chorus_recurrence": 1, "chorus_recurrence_margin": 1, "outro_vs_intro": 1,
          "lyric_coverage": 1, "key_agreement": 1, "tempo_drift": -1, "close_minus_body_db": -1}

LABELS = {
    "motif_margin": "前奏动机回到副歌（相对主歌的余量）", "motif_in_chorus": "前奏动机与副歌旋律的最佳匹配",
    "chorus_recurrence": "第二遍副歌与第一遍的相似度", "chorus_recurrence_margin": "副歌重现（相对主歌的余量）",
    "outro_vs_intro": "尾奏与前奏的呼应", "intro_s": "前奏长度（秒）", "outro_s": "尾奏长度（秒）",
    "chorus_lift_db": "副歌比主歌高（dB）", "chorus_brightness_ratio": "副歌亮度 / 主歌", "chorus_density_ratio": "副歌音符密度 / 主歌",
    "vocal_ratio_db": "人声与伴奏电平差（dB）", "lyric_coverage": "歌词听清比例", "lufs": "整体响度（LUFS）", "lra": "响度范围（LU）",
    "true_peak_db": "真峰值（dBTP）", "tempo_drift": "速度漂移（后半对前半，越小越稳）", "key_agreement": "调性一致的比例", "close_minus_body_db": "结尾比主体（dB，越低越像收束）",
}


def summarise(manifest: dict, measured: Dict[str, dict]) -> dict:
    rows = []
    for p in bp.pairs(manifest):
        a, b = measured.get(p["A"]["id"]), measured.get(p["B"]["id"])
        if not a or not b or "error" in a or "error" in b:
            continue
        fa, fb = flat(a), flat(b)
        rows.append({"brief": p["brief"], "seed": p["seed"], "A": fa, "B": fb,
                     "delta": {k: (round(fb[k] - fa[k], 3) if fa.get(k) is not None and fb.get(k) is not None else None) for k in fa}})
    overall = {}
    for k in LABELS:
        deltas = [r["delta"][k] for r in rows]
        sign = BETTER.get(k)
        st = qm.sign_test([d * sign if (d is not None and sign) else d for d in deltas]) if sign else None
        band_a = [in_band(k, r["A"][k]) for r in rows]
        band_b = [in_band(k, r["B"][k]) for r in rows]
        overall[k] = {
            "mean_A": _mean([r["A"][k] for r in rows]), "mean_B": _mean([r["B"][k] for r in rows]),
            "mean_delta": _mean(deltas), "sign_test": st,
            "in_band_A": sum(1 for x in band_a if x), "in_band_B": sum(1 for x in band_b if x),
            "measured": sum(1 for x in band_a if x is not None),
        }
    return {"pairs": rows, "overall": overall}


def _mean(xs):
    xs = [x for x in xs if x is not None]
    return round(float(np.mean(xs)), 3) if xs else None


def page(summary: dict, n_renders: int, validated: Optional[Dict[str, Optional[bool]]] = None) -> str:
    def fmt(x):
        return "—" if x is None else (f"{x:+.3f}" if isinstance(x, float) and abs(x) < 10 else f"{x}")

    rows = []
    for k, label in LABELS.items():
        o = summary["overall"][k]
        ref = REFERENCE.get(k)
        st = o["sign_test"]
        verdict = "" if not st else f"B 更好 {st['b_higher']} 对 · 更差 {st['b_lower']} 对 · p={st['p']}"
        band = f"{o['in_band_A']}/{o['measured']} → {o['in_band_B']}/{o['measured']}" if ref else ""
        v = (validated or {}).get(k, "none")
        mark = "✓ 已验证" if v is True else "✗ 未通过，不作判断" if v is False else "未验证"
        rows.append(f"<tr><td>{html.escape(label)}<br><span class=small>{mark}</span></td><td class=n>{fmt(o['mean_A'])}</td><td class=n>{fmt(o['mean_B'])}</td>"
                    f"<td class=n>{fmt(o['mean_delta'])}</td><td>{html.escape(verdict)}</td><td class=n>{band}</td>"
                    f"<td class=small>{html.escape(ref[2]) if ref else ''}</td></tr>")
    pairs = "".join(
        f"<tr><td>{html.escape(r['brief'])} s{r['seed']}</td>" + "".join(f"<td class=n>{fmt(r['delta'][k])}</td>" for k in ("motif_margin", "chorus_recurrence", "chorus_lift_db", "vocal_ratio_db", "lyric_coverage", "close_minus_body_db")) + "</tr>"
        for r in summary["pairs"])
    return (
        "<!doctype html><html lang=zh-CN><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
        "<title>制作质量报告</title><style>body{font:14px/1.6 system-ui,'PingFang SC',sans-serif;margin:24px auto;max-width:1100px;padding:0 16px}"
        "table{border-collapse:collapse;width:100%;margin:12px 0}td,th{padding:5px 8px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}"
        ".n{font-variant-numeric:tabular-nums;text-align:right}.small{color:#666;font-size:12px}p{max-width:75ch}</style>"
        "<h1>制作质量报告：A（现有流程）对 B（加制作提示）</h1>"
        f"<p>{n_renders} 个渲染，{len(summary['pairs'])} 对可比。全部是测量值，不是听感评分。"
        "每对同一首歌词、同一个种子，所以 B − A 只来自制作提示。「B 更好 n 对」按该指标「越大越好 / 越小越好」的方向计；"
        "p 是符号检验，样本只有 12 对，p 大于 0.05 时不能说有差别。参考区间是主流流媒体流行歌的经验值，不是硬标准。</p>"
        "<table><tr><th>指标<th>A 平均<th>B 平均<th>B−A<th>逐对比较<th>落在参考区间（A→B）<th>参考</tr>" + "".join(rows) + "</table>"
        "<h2>逐对 B − A</h2><table><tr><th>歌<th>动机回归余量<th>副歌重现<th>副歌抬升 dB<th>人声差 dB<th>歌词听清<th>结尾 dB</tr>" + pairs + "</table>"
        "<p class=small>测不到的：钩子好不好记、歌词动不动人、声音好不好听。这些指标只回答能测量的部分。</p></html>"
    )


# --------------------------------------------------------------- validation
def validate(source: Path, lyrics: str, work: Path) -> List[dict]:
    """
    Plant one defect at a time into a copy of a real render, and check the
    measure meant to catch it moves the right way. A measure that does not is
    not used to judge anything.
    """
    import librosa
    import soundfile as sf
    import separate

    work.mkdir(parents=True, exist_ok=True)
    y = separate.decode(source, 44100, 2)
    n = y.shape[1]
    variants = {}

    def write(name, data):
        wav = work / f"{name}.wav"
        sf.write(wav, data.T, 44100)
        mp3 = work / f"{name}.mp3"
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-b:a", "192k", str(mp3)], check=True)
        variants[name] = mp3

    write("original", y)
    # Cut off at 70% at full level, with only a 50 ms fade: a song that stops.
    cut = y[:, : int(n * 0.7)].copy()
    cut[:, -2205:] *= np.linspace(1, 0, 2205)
    write("hard_cut", cut)
    # Crushed: +14 dB into a hard clip.
    write("crushed", np.clip(y * 5.0, -1.0, 1.0))
    # Second half three semitones up: the key changes for no reason.
    half = n // 2
    shifted = np.stack([librosa.effects.pitch_shift(ch[half:], sr=44100, n_steps=3) for ch in y])
    write("key_jump", np.concatenate([y[:, :half], shifted], axis=1))
    # Second half 15% slower: a song that drags.
    second = np.stack([librosa.effects.time_stretch(ch[half:], rate=0.85) for ch in y])
    write("drag", np.concatenate([y[:, :half], second], axis=1))

    # The two a producer hears first, planted with the same tools the measures use.
    original = measure(variants["original"], lyrics)
    import app
    with app._gpu_lock:
        stem = separate.vocal_stem(variants["original"])
    if stem is not None:
        v, vsr = stem
        if vsr != 44100:
            v = librosa.resample(v, orig_sr=vsr, target_sr=44100)
        m = min(n, v.size)
        buried = y[:, :m].copy()
        buried -= v[None, :m] * (1 - 10 ** (-8 / 20))  # the vocal 8 dB down, the band untouched
        write("buried_vocal", buried)
    flat_chorus = y.copy()
    for sec in original.get("sections", []):
        if sec["name"] != "chorus":
            continue
        a, b = int(sec["start"] * 44100), min(n, int(sec["end"] * 44100))
        gain = np.full(b - a, 10 ** (-4 / 20))
        ramp = min(2205, (b - a) // 4)
        gain[:ramp] = np.linspace(1, gain[0], ramp)
        gain[-ramp:] = np.linspace(gain[0], 1, ramp)
        flat_chorus[:, a:b] *= gain
    write("flat_chorus", flat_chorus)

    got = {name: flat(original if name == "original" else measure(path, lyrics)) for name, path in variants.items()}
    o = got["original"]
    # (variant, measure, direction, at least this much movement, why). Moving
    # the right way by a hair is not catching the defect.
    checks = [
        ("hard_cut", "close_minus_body_db", "higher", 6.0, "被切断的结尾，结尾电平应接近主体"),
        ("crushed", "true_peak_db", "higher", 1.0, "削波后真峰值应升高"),
        ("crushed", "lra", "lower", 0.5, "压死后响度范围应变小"),
        ("key_jump", "key_agreement", "lower", 0.15, "中途升调后，调性一致比例应下降"),
        ("drag", "tempo_drift", "higher", 0.08, "后半慢 15%，速度漂移应明显增大"),
        ("buried_vocal", "vocal_ratio_db", "lower", 4.0, "人声压低 8 dB，人声与伴奏电平差应明显下降"),
        ("flat_chorus", "chorus_lift_db", "lower", 2.0, "副歌压低 4 dB，副歌抬升应明显下降"),
    ]
    results = []
    for variant, metric, way, need, why in checks:
        before = o.get(metric)
        after = got[variant].get(metric) if variant in got else None
        moved = None if before is None or after is None else (after - before if way == "higher" else before - after)
        results.append({"variant": variant, "metric": metric, "original": before, "defect": after,
                        "moved": None if moved is None else round(moved, 3), "needed": need,
                        "caught": None if moved is None else moved >= need, "why": why})
    return results


# ----------------------------------------------------------------------- main
def lyrics_of(manifest: dict, entry_id: str) -> str:
    """The A side's lyrics for the pair: same sung lines as B, with A's section tags."""
    e = next(x for x in manifest["entries"] if x["id"] == entry_id)
    a = next(x for x in manifest["entries"] if x["brief"] == e["brief"] and x["seed"] == e["seed"] and x["arm"] == "A")
    return a["request"].get("lyrics") or ""


def main(argv: List[str]) -> None:
    cmd = argv[1] if len(argv) > 1 else "run"
    manifest = bp.load_manifest()
    out = bp.OUT
    results = bp.read_results(out)
    ok = {i: r for i, r in results.items() if r.get("status") == "ok"}
    if not ok:
        raise SystemExit(f"no finished renders in {out}: run bench_production.py first")
    if cmd == "validate":
        first = sorted(ok)[0]
        checks = validate(out / ok[first]["audio"], lyrics_of(manifest, first), out / "validate")
        (out / "quality-validate.json").write_text(json.dumps(checks, indent=2, ensure_ascii=False), encoding="utf-8")
        for c in checks:
            mark = {True: "✓", False: "✗", None: "?"}[c["caught"]]
            print(f"{mark} {c['variant']:<13} {c['metric']:<22} {c['original']} → {c['defect']}  moved {c['moved']} (needs {c['needed']})  {c['why']}")
        return
    store = out / "quality.json"
    measured: Dict[str, dict] = json.loads(store.read_text(encoding="utf-8"))["renders"] if store.exists() else {}
    # A render measured before a measure existed is measured again, not reported without it.
    stale = lambda m: "error" not in m and m.get("time_key", {}).get("tempo_method") != TEMPO_METHOD  # noqa: E731
    todo = [i for i in sorted(ok) if i not in measured or stale(measured[i])]
    print(f"{len(measured)} measured, {len(todo)} to measure", flush=True)
    for n, i in enumerate(todo, 1):
        try:
            measured[i] = measure(out / ok[i]["audio"], lyrics_of(manifest, i))
        except Exception as err:  # one bad file is a finding, not the end of the report
            measured[i] = {"error": f"{type(err).__name__}: {str(err)[:200]}"}
        print(f"[{n}/{len(todo)}] {i}", flush=True)
        store.write_text(json.dumps({"renders": measured}, indent=1, ensure_ascii=False), encoding="utf-8")
    summary = summarise(manifest, measured)
    store.write_text(json.dumps({"renders": measured, "summary": summary}, indent=1, ensure_ascii=False), encoding="utf-8")
    checks = out / "quality-validate.json"
    validated: Dict[str, Optional[bool]] = {}
    if checks.exists():
        for c in json.loads(checks.read_text(encoding="utf-8")):
            # A measure with two checks is validated only if both caught.
            prev = validated.get(c["metric"], True)
            validated[c["metric"]] = None if c["caught"] is None else (prev is not False and c["caught"])
    (out / "quality.html").write_text(page(summary, len(measured), validated), encoding="utf-8")
    print(f"wrote {out / 'quality.html'}")


if __name__ == "__main__":
    main(sys.argv)
