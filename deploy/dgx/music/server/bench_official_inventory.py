"""
What is actually in a batch of official BGM, and what is still missing, before
any of it goes near YUHA (Marketplace PRD, "首批 30 首官方 BGM").

Read-only: it opens the directory, decodes every master once, and prints. It
writes nothing, renames nothing, converts nothing — the masters are the record
and the point of this step is to describe them, not to fix them.

The batch is laid out as (deploy/dgx/music/README.md, "Official BGM batches"):

  batch-01/
    manifest.csv     one row per track; columns below, any of them may be empty
    masters/         the audio exactly as generated (wav / mp3 / flac)
    covers/          optional; <id>.<jpg|png|webp> or named in the manifest
    generation/      whatever the generating script left (params, logs), as is

Run it from the music image, which already has ffmpeg and numpy, with the
batch mounted read-only:

  cd ~/yuha-spark && docker compose run --rm --no-deps \
    -v ~/yuha-official-bgm:/bgm:ro --entrypoint "" music \
    python bench_official_inventory.py /bgm/batch-01

--json prints the whole report as JSON instead (one object), for keeping.
Exit status is 0 when every track is complete, 1 when anything is missing,
2 when the batch cannot be read at all — so "nothing missing" is a claim the
run makes only when it checked something.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path

COLUMNS = ["id", "file", "title", "series", "style", "mood", "scenario", "cover",
           "model", "model_version", "seed", "prompt", "generated_at", "note"]
# What a track needs before it can even be reviewed. `note` and `cover` are
# not here: a note is optional, and a cover is checked as a file, not a column.
REQUIRED = ["id", "file", "title", "series", "style", "mood", "scenario",
            "model", "model_version", "seed", "prompt", "generated_at"]
AUDIO = {".wav", ".mp3", ".flac"}
IMAGES = (".jpg", ".jpeg", ".png", ".webp")
EXPECTED_TRACKS = 30
PREVIEW_SECONDS = 60          # the Marketplace preview's ceiling
SILENCE_DBFS = -50.0          # quieter than this at an edge counts as silence
CLIP_LEVEL = 0.999            # |sample| at or above this counts as clipped


# ----------------------------------------------------------------- manifest
def read_manifest(path: Path) -> tuple[list[dict], list[str]]:
    """Rows keyed by COLUMNS, and the problems with the sheet itself."""
    problems: list[str] = []
    if not path.exists():
        return [], ["manifest.csv is missing: every descriptive field is unknown"]
    with path.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        head = [h.strip() for h in (reader.fieldnames or [])]
        absent = [c for c in COLUMNS if c not in head]
        if absent:
            problems.append(f"manifest.csv has no column(s): {', '.join(absent)}")
        extra = [h for h in head if h and h not in COLUMNS]
        if extra:
            problems.append(f"manifest.csv has column(s) this does not read: {', '.join(extra)}")
        rows = []
        for raw in reader:
            row = {c: (raw.get(c) or "").strip() for c in COLUMNS}
            if any(row.values()):
                rows.append(row)
    if not rows:
        problems.append("manifest.csv has no rows")
    return rows, problems


def manifest_problems(rows: list[dict], masters: list[str]) -> list[str]:
    """Problems across rows: duplicates, and files the sheet and the folder disagree on."""
    out: list[str] = []
    seen: dict[str, int] = {}
    for r in rows:
        if r["id"]:
            seen[r["id"]] = seen.get(r["id"], 0) + 1
    out += [f"id {i} is used {n} times" for i, n in sorted(seen.items()) if n > 1]
    named = [r["file"] for r in rows if r["file"]]
    out += [f"{f} is named by {named.count(f)} rows" for f in sorted(set(named)) if named.count(f) > 1]
    out += [f"masters/{f} is in the folder but in no manifest row" for f in masters if f not in named]
    return out


def row_gaps(row: dict) -> list[str]:
    return [c for c in REQUIRED if not row.get(c)]


# -------------------------------------------------------------------- audio
def dbfs(x: float) -> float | None:
    return round(20 * math.log10(x), 1) if x > 0 else None


def analyse(samples, rate: int) -> dict:
    """Level facts about decoded float samples, shape (n,) or (n, channels), in [-1, 1]."""
    import numpy as np
    a = np.asarray(samples, dtype=np.float32)
    if a.ndim == 1:
        a = a[:, None]
    mono = np.abs(a).max(axis=1) if a.size else np.zeros(0, dtype=np.float32)
    peak = float(mono.max()) if mono.size else 0.0
    rms = float(np.sqrt(np.mean(a.astype(np.float64) ** 2))) if a.size else 0.0
    loud = np.nonzero(mono > 10 ** (SILENCE_DBFS / 20))[0]
    if loud.size:
        lead, tail = loud[0] / rate, (mono.size - 1 - loud[-1]) / rate
    else:
        lead = tail = mono.size / rate
    return {
        "peak_dbfs": dbfs(peak),
        "rms_dbfs": dbfs(rms),
        "clipped_samples": int((mono >= CLIP_LEVEL).sum()),
        "lead_silence_s": round(float(lead), 2),
        "tail_silence_s": round(float(tail), 2),
        "silent": not loud.size,
    }


def probe(path: Path) -> dict:
    """Container facts from ffprobe: codec, rate, channels, bit depth, bit rate, duration."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries",
         "stream=codec_name,sample_rate,channels,bits_per_sample,bits_per_raw_sample,bit_rate:format=duration,bit_rate",
         "-of", "json", str(path)],
        capture_output=True, text=True, check=True).stdout
    j = json.loads(out)
    s = (j.get("streams") or [{}])[0]
    fmt = j.get("format") or {}
    bits = int(s.get("bits_per_raw_sample") or s.get("bits_per_sample") or 0) or None
    rate = s.get("bit_rate") or fmt.get("bit_rate")
    return {
        "codec": s.get("codec_name"),
        "sample_rate": int(s["sample_rate"]) if s.get("sample_rate") else None,
        "channels": s.get("channels"),
        "bit_depth": bits,
        "kbps": round(int(rate) / 1000) if rate else None,
        "duration_s": round(float(fmt["duration"]), 2) if fmt.get("duration") else None,
    }


def decode(path: Path, rate: int, channels: int):
    import numpy as np
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-f", "f32le", "-acodec", "pcm_f32le",
                          "-ar", str(rate), "-ac", str(channels), "-"], capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, channels)


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def audio_problems(a: dict) -> list[str]:
    out = []
    if a.get("silent"):
        out.append("the whole file is silent")
    if a.get("clipped_samples"):
        out.append(f"{a['clipped_samples']} clipped samples")
    if (a.get("duration_s") or 0) < PREVIEW_SECONDS:
        out.append(f"shorter than the {PREVIEW_SECONDS} s preview ({a.get('duration_s')} s): the preview would be the whole track")
    if (a.get("lead_silence_s") or 0) > 2:
        out.append(f"{a['lead_silence_s']} s of silence at the start")
    if (a.get("tail_silence_s") or 0) > 3:
        out.append(f"{a['tail_silence_s']} s of silence at the end")
    return out


def inspect_audio(path: Path) -> dict:
    info = probe(path)
    rate, ch = info["sample_rate"] or 44100, info["channels"] or 2
    info.update(analyse(decode(path, rate, ch), rate))
    info["bytes"] = path.stat().st_size
    info["sha256"] = sha256(path)
    return info


# ------------------------------------------------------------------- report
def find_cover(batch: Path, row: dict) -> str | None:
    if row.get("cover"):
        p = batch / row["cover"]
        if not p.exists():
            p = batch / "covers" / row["cover"]
        return str(p.relative_to(batch)) if p.exists() else None
    for ext in IMAGES:
        p = batch / "covers" / f"{row.get('id')}{ext}"
        if row.get("id") and p.exists():
            return str(p.relative_to(batch))
    return None


def build_report(batch: Path, inspect=inspect_audio) -> dict:
    masters_dir = batch / "masters"
    masters = sorted(p.name for p in masters_dir.iterdir() if p.suffix.lower() in AUDIO) if masters_dir.is_dir() else []
    rows, sheet = read_manifest(batch / "manifest.csv")
    batch_problems = list(sheet)
    if not masters_dir.is_dir():
        batch_problems.append("masters/ is missing")
    batch_problems += manifest_problems(rows, masters)
    # A master no row names is still a track: list it, with everything unknown.
    named = {r["file"] for r in rows}
    rows = rows + [{**{c: "" for c in COLUMNS}, "file": f} for f in masters if f not in named]

    tracks, hashes = [], {}
    for r in rows:
        t = {"id": r["id"] or None, "file": r["file"] or None, "title": r["title"] or None,
             "missing": row_gaps(r), "problems": []}
        p = masters_dir / r["file"] if r["file"] else None
        if p is None or not p.exists():
            t["problems"].append("no audio file" if p is None else f"masters/{r['file']} does not exist")
        else:
            try:
                a = inspect(p)
                t["audio"] = a
                t["problems"] += audio_problems(a)
                hashes.setdefault(a["sha256"], []).append(r["file"])
            except (subprocess.CalledProcessError, OSError, ValueError) as e:
                t["problems"].append(f"could not decode: {e}")
        t["cover"] = find_cover(batch, r)
        if not t["cover"]:
            t["missing"].append("cover file")
        tracks.append(t)
    batch_problems += [f"identical audio: {', '.join(fs)}" for fs in hashes.values() if len(fs) > 1]
    if len(tracks) != EXPECTED_TRACKS:
        batch_problems.append(f"{len(tracks)} tracks, not {EXPECTED_TRACKS}")
    complete = sum(1 for t in tracks if not t["missing"] and not t["problems"])
    return {"batch": str(batch), "tracks": len(tracks), "complete": complete,
            "batch_problems": batch_problems, "items": tracks}


def print_report(rep: dict) -> None:
    print(f"{rep['batch']}: {rep['tracks']} tracks, {rep['complete']} complete")
    for p in rep["batch_problems"]:
        print(f"  ! {p}")
    for t in rep["items"]:
        a = t.get("audio") or {}
        facts = (f"{a.get('codec')} {a.get('sample_rate')}Hz {a.get('channels')}ch "
                 f"{a.get('bit_depth') or '-'}bit {a.get('kbps') or '-'}kbps {a.get('duration_s')}s "
                 f"peak {a.get('peak_dbfs')}dBFS rms {a.get('rms_dbfs')}dBFS") if a else "no audio"
        print(f"\n{t['id'] or '(no id)'}  {t['file'] or '(no file)'}  {t['title'] or '(no title)'}")
        print(f"    {facts}")
        if a:
            print(f"    sha256 {a['sha256']}")
        if t["missing"]:
            print(f"    missing: {', '.join(t['missing'])}")
        for p in t["problems"]:
            print(f"    problem: {p}")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("batch")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    batch = Path(args.batch)
    if not batch.is_dir():
        print(f"{batch} is not a directory", file=sys.stderr)
        sys.exit(2)
    if not shutil.which("ffprobe"):
        print("ffprobe is not installed here; run it from the music image (see the top of this file)", file=sys.stderr)
        sys.exit(2)
    rep = build_report(batch)
    if rep["tracks"] == 0:
        print(f"{batch}: no tracks found (no manifest rows and nothing in masters/)", file=sys.stderr)
        sys.exit(2)  # a run over nothing is not a pass
    if args.json:
        print(json.dumps(rep, ensure_ascii=False, indent=1))
    else:
        print_report(rep)
    sys.exit(0 if rep["complete"] == rep["tracks"] and not rep["batch_problems"] else 1)


if __name__ == "__main__":
    main()
