"""
Section-tag benchmark: does ACE-Step act on [rap], [interlude], [bridge]?

YUHA writes section markers into the lyrics and translates a creator's
`[副歌]` into `[chorus]` on the way out, on the strength of the intent prompt
having always asked for `[verse]/[chorus]/[bridge]`. Which tags the model
*acts on* has never been measured. This measures it.

Why it cannot be done over HTTP: /submit picks a random seed per take, so two
runs of the same request differ anyway and a single run per tag proves
nothing. Here `app.render` is called directly with a fixed seed, so the tag is
the only thing that changes between a take and its control.

The judgement, and why it needs a nonsense tag
----------------------------------------------
A section tag is part of the lyrics string, so ANY bracketed line changes the
conditioning and therefore the audio. "It sounds different from the control"
is worth nothing on its own. So every real tag is compared against
`[qwinter]` — a word the model cannot know — rendered at the same seed in the
same place:

    a tag is ACTED ON when its distance from the control is materially larger
    than the nonsense tag's distance from the control.

If `[rap]` moves the song no more than `[qwinter]` does, the model is
responding to "there is some bracketed text here", not to the word rap, and
YUHA should stop implying otherwise.

Two numbers per take, both ear-checkable in the report:
  env   — distance between per-frame energy envelopes. Structure (a rap
          section, an interlude, a solo) lives in where the song is loud and
          where it is not, so this is the measure that matches the claim.
  sung  — whether Whisper hears the tag word in the vocal. A tag sung aloud is
          the loudest possible failure and the one YUHA just fixed in its own
          parser; worth knowing whether the model does it too.

Run on the DGX (inside the music image, while the service keeps serving):
    cd ~/yuha-spark && docker compose run --rm -v "$PWD/bench_out:/bench" music \
        python /opt/server/bench_sections.py              # 12 conditions x 2 seeds
    ... python /opt/server/bench_sections.py --quick      # 5 conditions x 1 seed
    ... python /opt/server/bench_sections.py --tags=rap,interlude
Then open bench_out/sections/report.html (scp it to your Mac).
"""
from __future__ import annotations

import csv
import html
import os
import subprocess
import sys
import time
import wave
from pathlib import Path

import numpy as np

import app  # the service module: the same render path production uses

OUT = Path(os.environ.get("BENCH_OUT", "/bench")) / "sections"
DUR = 60
SEEDS = [11, 22]
QUICK_SEEDS = [11]

# The ten tags YUHA's intent prompt now names, plus the two controls.
TAGS = ["intro", "verse", "pre-chorus", "chorus", "bridge", "rap", "interlude", "instrumental", "solo", "outro"]
QUICK_TAGS = ["rap", "chorus", "interlude", "instrumental"]
NONSENSE = "qwinter"  # not a word; the yardstick every real tag is measured against

# One song, held fixed. Eight lines in two stanzas, sized for 60 seconds, with
# the tag inserted between them — the one place where a section change would
# have something to separate.
HEAD = ["Street lights are sliding past the glass", "I am counting every one tonight",
        "Nothing here is asking me to stay", "The city hums and lets me go"]
TAIL = ["Somewhere past the river there is morning", "I will meet it when it comes",
        "Keep the engine running low and easy", "There is time enough to drive"]

BASE = dict(
    style_tags=["pop", "city pop"],
    instruments=["electric_piano", "bass", "soft_drums"],
    tempo="medium",
    energy=0.5,
    prompt="late night city pop, clear lead vocals, electric piano",
)


def lyrics_for(tag: str | None) -> str:
    """The same words every time; only the line between the stanzas changes."""
    middle = [] if tag is None else [f"[{tag}]"]
    return "\n".join(HEAD + middle + TAIL)


def envelope(path: Path, frame_ms: int = 50) -> np.ndarray:
    """Per-frame RMS, normalised. Where the song is loud, over time."""
    with wave.open(str(path), "rb") as w:
        rate, width, chans = w.getframerate(), w.getsampwidth(), w.getnchannels()
        raw = w.readframes(w.getnframes())
    dtype = {1: np.int8, 2: np.int16, 4: np.int32}[width]
    x = np.frombuffer(raw, dtype=dtype).astype(np.float64)
    if chans > 1:
        x = x.reshape(-1, chans).mean(axis=1)
    step = max(1, int(rate * frame_ms / 1000))
    frames = len(x) // step
    if frames == 0:
        return np.zeros(1)
    env = np.sqrt((x[: frames * step].reshape(frames, step) ** 2).mean(axis=1))
    peak = env.max()
    return env / peak if peak > 0 else env


def env_distance(a: np.ndarray, b: np.ndarray) -> float:
    """Mean absolute difference between two envelopes, 0 = identical."""
    n = min(len(a), len(b))
    if n == 0:
        return 0.0
    return float(np.abs(a[:n] - b[:n]).mean())


def sung(path: Path, lyrics: str, tag: str) -> bool:
    """Did the model sing the tag word instead of acting on it?"""
    try:
        text = "".join(w for w, _, _ in app.transcribe_words(path, lyrics)).lower()
    except Exception:
        return False
    return tag.replace("-", " ").lower() in text or tag.lower() in text


def main() -> None:
    quick = "--quick" in sys.argv
    picked = [a.split("=", 1)[1].split(",") for a in sys.argv if a.startswith("--tags=")]
    tags = picked[0] if picked else (QUICK_TAGS if quick else TAGS)
    seeds = QUICK_SEEDS if quick else SEEDS

    OUT.mkdir(parents=True, exist_ok=True)
    print("loading whisper…", flush=True)
    # Only whisper is loaded here. `render` pulls whichever engine the service
    # is configured for, lazily — loading the v1 pipeline on a box running v15
    # would cost minutes and a lot of memory for nothing.
    app.get_whisper()

    conditions = [("control", None), (f"nonsense[{NONSENSE}]", NONSENSE)] + [(t, t) for t in tags]
    rows: list[dict] = []
    envs: dict[tuple[str, int], np.ndarray] = {}
    total = len(conditions) * len(seeds)
    n = 0

    for name, tag in conditions:
        lyrics = lyrics_for(tag)
        req = {**BASE, "duration_seconds": DUR, "instrumental": False, "lyrics": lyrics, "format": "mp3"}
        for seed in seeds:
            n += 1
            t0 = time.time()
            work = OUT / "tmp" / f"{name}-{seed}"
            wav = app.render(req, work, seed=seed)
            took = time.time() - t0
            envs[(name, seed)] = envelope(wav)
            # Encoded for listening only, and deliberately NOT through the
            # service's master step: that applies loudnorm, which would even
            # out precisely the energy differences being measured. The
            # envelope above is taken from the raw render.
            mp3 = OUT / "takes" / f"{name}-s{seed}.mp3"
            mp3.parent.mkdir(parents=True, exist_ok=True)
            subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(wav), "-b:a", "192k", str(mp3)], check=True)
            rows.append(dict(
                condition=name,
                tag=tag or "",
                seed=seed,
                audio=str(mp3.relative_to(OUT)),
                sung=sung(wav, lyrics, tag) if tag else False,
                seconds=round(took, 1),
            ))
            print(f"[{n}/{total}] {name} seed={seed} {took:.0f}s", flush=True)

    # Distances, each take against the control rendered at the same seed.
    for row in rows:
        key = (row["condition"], row["seed"])
        control = envs.get(("control", row["seed"]))
        row["env"] = round(env_distance(envs[key], control), 4) if control is not None else ""

    # The yardstick: how far a word the model cannot know moves the song.
    noise = [r["env"] for r in rows if r["condition"].startswith("nonsense") and r["env"] != ""]
    floor = max(noise) if noise else 0.0
    for row in rows:
        row["verdict"] = (
            "" if row["condition"] == "control" or row["env"] == ""
            else "acted on" if row["env"] > floor * 1.5
            else "indistinguishable from nonsense"
        )

    with (OUT / "report.csv").open("w", newline="") as fh:
        wr = csv.DictWriter(fh, fieldnames=["condition", "tag", "seed", "env", "verdict", "sung", "seconds", "audio"])
        wr.writeheader()
        wr.writerows(rows)

    write_report(rows, floor)
    print(f"\nnonsense floor: {floor:.4f}  (a tag counts as acted on above {floor * 1.5:.4f})")
    print(f"wrote {OUT / 'report.html'}")


def write_report(rows: list[dict], floor: float) -> None:
    def cell(r: dict) -> str:
        bar = min(1.0, (r["env"] / (floor * 4)) if floor and r["env"] != "" else 0)
        return (
            f"<tr><td>{html.escape(r['condition'])}</td><td>{r['seed']}</td>"
            f"<td class=n>{r['env']}</td>"
            f"<td><span class=bar style='width:{bar * 100:.0f}%'></span></td>"
            f"<td>{html.escape(r['verdict'])}</td>"
            f"<td>{'SUNG ALOUD' if r['sung'] else ''}</td>"
            f"<td><audio controls preload=none src='{html.escape(r['audio'])}'></audio></td></tr>"
        )

    body = "".join(cell(r) for r in rows)
    (OUT / "report.html").write_text(
        "<!doctype html><meta charset=utf-8><title>section tags</title>"
        "<style>body{font:14px system-ui;margin:24px;max-width:1100px}"
        "table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid #eee;text-align:left}"
        ".n{font-variant-numeric:tabular-nums}.bar{display:block;height:8px;background:#e8449a;border-radius:4px}"
        "p{color:#555;line-height:1.6;max-width:70ch}</style>"
        "<h1>Does the model act on a section tag?</h1>"
        f"<p>Every take is the same song at the same seed; only the bracketed line between the two "
        f"stanzas differs. <b>env</b> is how far the song's energy envelope moved from the control. "
        f"A bracketed line always changes the conditioning, so the number that matters is the comparison "
        f"with <b>nonsense[{NONSENSE}]</b> — a word the model cannot know. Its distance here is "
        f"<b>{floor:.4f}</b>; a tag is called acted on above {floor * 1.5:.4f}. "
        f"Listen before believing the arithmetic: the number says the song changed, not that it changed "
        f"<i>correctly</i>.</p>"
        "<table><tr><th>condition<th>seed<th>env<th><th>verdict<th>sung<th>listen</tr>"
        + body + "</table>",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
