"""
Which aligner times sung lyrics best, on this box's own songs (docs: README, "Choosing an aligner").

Each recent sung song in data/ is separated once (demucs), then aligned by:

  whisper  what the service runs today: Whisper on the vocal stem, matched to
           the known lyrics (align.align_lines), with per-line confidence.
  qwen     Qwen3-ForcedAligner-0.6B (weights and code Apache-2.0): the known
           lyrics placed on the stem, character by character.

There is no ground truth on this box, so the comparison is against what can
be believed: the lines Whisper heard whole (confidence 1.0). A forced aligner
that is right agrees with them closely, and also times the lines Whisper did
not hear. Reported per method: how many lines it timed, and for the lines
Whisper heard whole, how far its start is from Whisper's (median, p90, share
within 0.3 / 0.5 / 1.0 s). Everything is written to --out for listening.

It never runs inside the service. Run it in a throwaway container from the
music image, in a venv that adds qwen-asr beside the image's own CUDA torch.
qwen-asr and accelerate go in with --no-deps: accelerate asks for torch>=2.0,
and the image's torch has a pre-release version pip does not count as that
(the same trap as demucs, see the Dockerfile). Nothing else here wants torch;
nagisa and DyNet38 have cp312 aarch64 wheels. See the README for the command.

Agreement with Whisper is a proxy, not the truth: Whisper's own starts run
early in places (a forced aligner that is right will disagree there). Human-
corrected timelines from YUHA are the ground truth to score against next.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import statistics
import time
from pathlib import Path

LANGS = {"zh": "Chinese", "ja": "Japanese", "en": "English"}


def separate_seconds(path: Path) -> float:
    import subprocess
    return float(subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of",
                                 "default=nw=1:nk=1", str(path)], capture_output=True, text=True, check=True).stdout.strip())


def songs(data: Path, limit: int):
    out = []
    for f in sorted(glob.glob(str(data / "jobs" / "*.json")), key=os.path.getmtime, reverse=True):
        j = json.load(open(f))
        r = j.get("request", {})
        mp3 = data / "audio" / f"{j['id']}.mp3"
        if j.get("status") == "succeeded" and r.get("lyrics") and mp3.exists():
            out.append((j["id"], r["lyrics"], float(j.get("audio_seconds") or r["duration_seconds"]), mp3))
        if len(out) >= limit:
            break
    return out


def truth_songs(truth: Path, data: Path):
    """Staff songs a person timed by hand (`pnpm bench:lyric-truth`), with their audio on this box."""
    out = []
    for s in json.load(open(truth / "songs.json")):
        mp3 = data / "audio" / f"{s.get('providerRequestId')}.mp3"
        if s.get("providerRequestId") and mp3.exists():
            out.append((s["songId"], s["lyrics"], None, mp3))
        else:
            print(f"{s['songId'][:8]}: no audio here (kept {os.environ.get('RETENTION_DAYS', 6)} days); skipped", flush=True)
    return out


def as_route(lines: list) -> dict:
    """A lyricTimings the scorer (scripts/lyric-bench.mjs) reads: one entry per lyric line, untimed ones unconfirmed."""
    out, last = [], 0.0
    for l in lines:
        start = l.get("start")
        if start is None:
            out.append({"text": l["text"], "section": l.get("section", ""), "start": last, "end": last, "confidence": 0.0})
            continue
        last = float(l.get("end") or start)
        out.append({"text": l["text"], "section": l.get("section", ""), "start": float(start), "end": last,
                    "confidence": float(l.get("confidence", 1.0))})
    return {"source": "aligned", "lines": out}


def agreement(reference: list, other: list) -> list:
    """|start difference| on the lines Whisper heard whole and the other method timed."""
    return [abs(o["start"] - w["start"]) for w, o in zip(reference, other)
            if w.get("confidence", 0) >= 1.0 and o.get("start") is not None]


def summary(name: str, timed: int, total: int, diffs: list, seconds: float) -> str:
    if not diffs:
        return f"{name:8} timed {timed}/{total} lines; no lines to compare; {seconds:.0f}s"
    d = sorted(diffs)
    p90 = d[min(len(d) - 1, int(len(d) * 0.9))]
    within = lambda s: sum(x <= s for x in d) / len(d)
    return (f"{name:8} timed {timed}/{total} lines | vs whisper-heard lines (n={len(d)}): "
            f"median {statistics.median(d):.2f}s p90 {p90:.2f}s | within 0.3s {within(0.3):.0%} "
            f"0.5s {within(0.5):.0%} 1.0s {within(1.0):.0%} | {seconds:.0f}s")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="/data")
    ap.add_argument("--songs", type=int, default=10)
    ap.add_argument("--out", default="/out")
    ap.add_argument("--methods", default="whisper,qwen")
    ap.add_argument("--truth", default=None,
                    help="a `pnpm bench:lyric-truth` export: align those songs and write routes/<method>/ beside it")
    args = ap.parse_args()
    methods = args.methods.split(",")
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    import separate
    from align import align_lines, fuse_lines, guess_language, parse_lyrics, qwen_lines, voiced_intervals
    qwen = None
    if "qwen" in methods:
        import torch
        from qwen_asr import Qwen3ForcedAligner
        qwen = Qwen3ForcedAligner.from_pretrained("Qwen/Qwen3-ForcedAligner-0.6B", dtype=torch.bfloat16,
                                                  device_map="cuda:0" if torch.cuda.is_available() else "cpu")

    if "qwen" in methods and "fused" not in methods:
        methods.append("fused")  # Qwen and Whisper averaged where they agree (align.fuse_lines)
    totals = {m: {"timed": 0, "lines": 0, "diffs": [], "seconds": 0.0} for m in methods}
    truth = Path(args.truth) if args.truth else None
    picked = truth_songs(truth, Path(args.data)) if truth else songs(Path(args.data), args.songs)
    if not picked:
        raise SystemExit("no songs to align")  # a run over nothing is not a result
    for sid, lyrics, dur, mp3 in picked:
        if dur is None:
            dur = separate_seconds(mp3)
        stem = separate.vocal_stem(mp3)
        if stem is None:
            print(f"{sid[:8]}: no vocal stem ({separate.status().get('error')}); skipped", flush=True)
            continue
        mono, sr = stem
        stem16 = separate.to_16k(mono, sr)
        voiced = voiced_intervals(separate.loudness_envelope(mono, sr), 0.02) or None
        lang = guess_language(lyrics) or "zh"
        record = {"id": sid, "lang": lang, "duration": dur, "lyrics": lyrics}

        t = time.time()
        import app
        w = align_lines(lyrics, app.transcribe_words(stem16, lyrics), dur, voiced=voiced)
        record["whisper"] = {"coverage": w["coverage"], "lines": w["lines"], "seconds": round(time.time() - t, 1)}
        ref = w["lines"]
        if "whisper" in methods:
            tw = totals["whisper"]
            tw["timed"] += sum(l["confidence"] >= 0.5 for l in ref)
            tw["lines"] += len(ref)
            tw["seconds"] += time.time() - t

        if qwen is not None:
            t = time.time()
            text = " ".join(line for _, line in parse_lyrics(lyrics))
            res = qwen.align(audio=(stem16, 16000), text=text, language=LANGS.get(lang, "Chinese"))
            units = [(u.text, float(u.start_time), float(u.end_time)) for u in res[0]]
            # What the service would return: per-line confidence from the voice and from Whisper.
            q = qwen_lines(lyrics, units, dur, voiced=voiced, heard=ref)
            record["qwen"] = {"lines": q, "seconds": round(time.time() - t, 1)}
            tq = totals["qwen"]
            tq["timed"] += sum(l["confidence"] >= 0.5 for l in q)
            tq["lines"] += len(q)
            tq["diffs"] += agreement(ref, q)
            tq["seconds"] += time.time() - t
            fused, offset = fuse_lines(q, ref, w_qwen=float(os.environ.get("ALIGN_QWEN_WEIGHT", "0.5")))
            record["fused"] = {"lines": fused, "whisper_offset": offset}
            tf = totals["fused"]
            tf["timed"] += sum(l["confidence"] >= 0.5 for l in fused)
            tf["lines"] += len(fused)

        (out / f"{sid}.json").write_text(json.dumps(record, ensure_ascii=False, indent=1))
        if truth:
            for m in ("whisper", "qwen", "fused"):
                if m in record and m in methods:
                    d = truth / "routes" / m
                    d.mkdir(parents=True, exist_ok=True)
                    (d / f"{sid}.json").write_text(json.dumps(as_route(record[m]["lines"]), ensure_ascii=False))
        line = f"{sid[:8]} {lang} whisper coverage={w['coverage']:.2f} heard-whole={sum(l['confidence'] >= 1.0 for l in ref)}/{len(ref)}"
        if "qwen" in record:
            d = agreement(ref, record["qwen"]["lines"])
            line += f" | qwen trusted {sum(l['confidence'] >= 0.5 for l in record['qwen']['lines'])}/{len(ref)}"
            line += f" | whisper offset {record['fused']['whisper_offset']:+.2f}s"
            if d:
                line += f", median |Δstart| {statistics.median(d):.2f}s"
        print(line, flush=True)

    print()
    for m in methods:
        t = totals[m]
        print(summary(m, t["timed"], t["lines"], t["diffs"], t["seconds"]))
    print(f"\nper-song detail in {out}/<id>.json (line starts from each method, for listening)")
    if truth:
        print(f"routes written to {truth}/routes/; score them: node scripts/lyric-bench.mjs {truth} --base whisper")


if __name__ == "__main__":
    main()
