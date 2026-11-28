"""
Production benchmark: does a production plan make a better song?
(docs/MUSIC_PRODUCTION_SPEC.md, step 1)

Every render is decided in advance, in fixtures/production_bench.json, which
scripts/production-bench.mjs writes from the repository's own compiler:
six briefs (zh/ja/en x pop/ballad) x two fixed seeds x two arms.

    A — the request as production sends it today;
    B — the same request after the production plan, which may change only
        `prompt` and `lyrics` (the generator refuses to write one that
        changes anything else).

This script renders them here, with the service's own render and master,
and turns them into two things:

    listen/index.html — the blind page. Each pair is the same brief at the
                        same seed, shown as X and Y in a random order, at
                        matched loudness. Nothing on it says which is A.
    report.html       — the engineer's page: every render with its request,
                        timings and diagnostics. Unblinded: do not open it
                        before listening.

Run on the DGX, inside the music image, while the service keeps serving:

    cd ~/yuha-spark && docker compose run --rm -v "$PWD/bench_out:/bench" music \\
        python /opt/server/bench_production.py run        # renders what is not done yet
    ... python /opt/server/bench_production.py run --only=zh-pop   # one brief
    ... python /opt/server/bench_production.py pages      # rebuild both pages
    ... python /opt/server/bench_production.py score judgments/*.json

`run` is resumable: each render is written to results.jsonl as it finishes,
a finished one is never rendered again, and a failed one is retried on the
next run. Interrupt it whenever; run it again.

What it refuses to do: render a request whose tag string the service would
build differently from the one the compiler recorded (the parity check), or
render with anything but the v2 tag builder those strings describe.

Diagnostics are clues, each with its confidence; none of them decides which
arm is better. That is the listeners' job (score).
"""
from __future__ import annotations

import hashlib
import html
import json
import os
import random
import re
import shutil
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

HERE = Path(__file__).resolve().parent
MANIFEST = HERE / "fixtures" / "production_bench.json"
OUT = Path(os.environ.get("BENCH_OUT", "/bench")) / "production"
TARGET_LUFS = -16.0
SECTION_WORDS = ["intro", "verse", "chorus", "pre-chorus", "bridge", "outro"]
ISSUES = [
    ("jump", "过渡像跳到另一首歌"),
    ("no_hook", "副歌认不出前奏的主题"),
    ("loud_only", "变化只靠整体变响"),
    ("buried", "伴奏压住关键句"),
    ("unclear", "关键句听不清 / 发音跑偏"),
    ("missing", "漏唱 / 换词 / 衬词代替"),
    ("tag_sung", "段落标签被唱出来"),
    ("voice_jump", "主唱音色突变"),
    ("hard_cut", "结尾被硬切"),
    ("other", "其他"),
]
CRITERIA = [
    ("theme", "主题与回归", "能哼出同一个主题，第二次副歌还能认出它"),
    ("contrast", "对比与过渡", "主副歌有角色差别，进出顺畅，收尾自然"),
    ("vocal", "演唱与伴奏", "关键句清楚、有呼吸，发音、主唱音色和伴奏让位自然"),
    ("whole", "完整成品", "愿意把这首听完，符合原描述的情绪与风格"),
]


# --------------------------------------------------------------- the manifest
def load_manifest(path: Path = MANIFEST) -> dict:
    m = json.loads(path.read_text(encoding="utf-8"))
    ids = [e["id"] for e in m["entries"]]
    if len(ids) != len(set(ids)):
        raise ValueError("manifest has duplicate ids")
    return m


def parity_problems(manifest: dict, build_tags: Callable[[dict], str]) -> list[str]:
    """Requests whose tag string this service would build differently from the compiler's record."""
    out = []
    for e in manifest["entries"]:
        got = build_tags(e["request"])
        if got != e["expected_tags_v2"]:
            out.append(f"{e['id']}: service builds {got!r}, compiler recorded {e['expected_tags_v2']!r}")
    return out


def pairs(manifest: dict) -> list[dict]:
    """(brief, seed) -> its A and B entries."""
    by: dict[tuple, dict] = {}
    for e in manifest["entries"]:
        by.setdefault((e["brief"], e["seed"]), {})[e["arm"]] = e
    return [{"brief": b, "seed": s, "A": v["A"], "B": v["B"]} for (b, s), v in by.items()]


# ------------------------------------------------------------------- the tools
@dataclass
class Tools:
    """Everything that touches audio or a model. Tests replace every field."""
    render: Callable[..., Path]                         # (request, work_dir, seed=, tag_style=) -> wav
    master: Callable[[Path, Path], dict]                # (wav, mp3) -> what mastering applied
    inspect: Callable[[Path], dict]                     # mp3 -> duration_s, peak, clipping, silences
    coverage: Callable[[Path, str], float]              # (wav, lyrics) -> share of lyric heard, 0..1
    transcript: Callable[[Path, str], str]              # (wav, lyrics) -> what was heard
    loudness: Callable[[Path], Optional[float]]         # mp3 -> integrated LUFS
    gain_copy: Callable[[Path, Path, float], None]      # (src, dst, dB) -> a copy at that gain, dynamics kept
    # The service's own tag builder. Required, with no fallback: a parity check
    # against the recorded string itself would pass for anything.
    build_tags: Callable[[dict], str]
    environment: dict = field(default_factory=dict)


def service_tools() -> Tools:
    """The real thing: the service's own render and master."""
    import subprocess
    import app
    import bench_official_inventory as inv

    def master(wav: Path, mp3: Path) -> dict:
        mp3.parent.mkdir(parents=True, exist_ok=True)
        return app._master(wav, mp3, want_seconds=app._probe_seconds(wav))

    def transcript(wav: Path, lyrics: str) -> str:
        return " ".join(w for w, _, _ in app.transcribe_words(wav, lyrics))

    def loudness(path: Path) -> Optional[float]:
        p = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(path), "-af", "ebur128", "-f", "null", "-"],
                           capture_output=True, text=True)
        found = re.findall(r"I:\s*(-?\d+(?:\.\d+)?) LUFS", p.stderr)
        return float(found[-1]) if found else None

    def gain_copy(src: Path, dst: Path, db: float) -> None:
        dst.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(src), "-af", f"volume={db:.2f}dB",
                        "-codec:a", "libmp3lame", "-b:a", "192k", str(dst)], check=True)

    code = hashlib.sha256((HERE / "app.py").read_bytes()).hexdigest()[:12]
    env = {
        "engine": app.ENGINE, "service_tag_style": app.TAG_STYLE, "bench_tag_style": "v2",
        "v15_model": getattr(app, "V15_MODEL", None), "v15_steps": getattr(app, "V15_STEPS", None),
        "v15_thinking": getattr(app, "V15_THINKING", None), "infer_steps": getattr(app, "INFER_STEPS", None),
        "lyric_guidance": getattr(app, "LYRIC_GUIDANCE", None), "vocal_takes": app.VOCAL_TAKES,
        "master_polish": getattr(app, "MASTER_POLISH", None), "master_lufs": getattr(app, "MASTER_LUFS", None),
        "build_sha": os.environ.get("BUILD_SHA") or os.environ.get("GIT_SHA") or None, "app_py_sha256": code,
    }
    return Tools(
        render=lambda req, work, seed, tag_style: app.render(req, work, seed=seed, tag_style=tag_style),
        master=master, inspect=inv.inspect_audio,
        coverage=app.intelligibility, transcript=transcript,
        loudness=loudness, gain_copy=gain_copy, build_tags=app.build_tags_v2, environment=env,
    )


# ------------------------------------------------------------------ diagnosis
def diagnose(tools: Tools, wav: Path, mp3: Path, request: dict) -> dict:
    """Clues, each with a confidence. 'unknown' never counts for or against an arm."""
    def clue(value, confidence="measured"):
        return {"value": value, "confidence": confidence}

    unknown = {"value": None, "confidence": "unknown"}
    out: dict = {}
    try:
        a = tools.inspect(mp3)
        out["duration_s"] = clue(a.get("duration_s"))
        out["lead_silence_s"] = clue(a.get("lead_silence_s"))
        out["tail_silence_s"] = clue(a.get("tail_silence_s"))
        out["clipped_samples"] = clue(a.get("clipped_samples"))
        out["peak_dbfs"] = clue(a.get("peak_dbfs"))
        out["silent"] = clue(bool(a.get("silent")))
        want = float(request.get("duration_seconds") or 0)
        got = a.get("duration_s")
        out["short_by_s"] = clue(round(want - got, 2) if got is not None and want else None)
    except Exception as e:  # a broken file is itself the finding
        out["inspect_error"] = clue(repr(e)[:200])
    lyrics = request.get("lyrics") or ""
    if lyrics and not request.get("instrumental"):
        try:
            # Whisper's share of the lyric it could place in order: a clue to a
            # missed line, never proof — a sung line Whisper mishears counts as missing.
            out["lyric_coverage"] = clue(round(float(tools.coverage(wav, lyrics)), 3), "clue")
        except Exception:
            out["lyric_coverage"] = unknown
        try:
            heard = tools.transcript(wav, lyrics).lower()
            in_lyrics = {w for w in SECTION_WORDS if re.search(rf"(?<!\[){re.escape(w)}\b", lyrics.lower())}
            hits = [w for w in SECTION_WORDS if w not in in_lyrics and re.search(rf"\b{re.escape(w)}\b", heard)]
            out["section_word_sung"] = clue(hits, "clue")
        except Exception:
            out["section_word_sung"] = unknown
    else:
        out["lyric_coverage"] = unknown
        out["section_word_sung"] = unknown
    return out


# ------------------------------------------------------------------------ run
def read_results(out: Path) -> dict[str, dict]:
    """The latest record per id. A later line overrides an earlier one."""
    p = out / "results.jsonl"
    latest: dict[str, dict] = {}
    if p.exists():
        for line in p.read_text(encoding="utf-8").splitlines():
            if line.strip():
                r = json.loads(line)
                latest[r["id"]] = r
    return latest


# What makes two renders of the same entry comparable: what was asked, at
# which seed, through which engine, settings, code and mastering. A build SHA
# or the service's own TAG_STYLE (v15 ignores it; the bench forces v2) is not.
FINGERPRINT_KEYS = ("engine", "bench_tag_style", "v15_model", "v15_steps", "v15_thinking", "infer_steps",
                    "lyric_guidance", "master_polish", "master_lufs", "app_py_sha256")


def fingerprint(input_version: str, seed: int, environment: dict) -> str:
    """Computed from fields every record already stores, so a run in progress needs no migration."""
    basis = {"input_version": input_version, "seed": seed,
             "environment": {k: environment.get(k) for k in FINGERPRINT_KEYS}}
    return hashlib.sha256(json.dumps(basis, sort_keys=True).encode()).hexdigest()[:16]


def run(manifest: dict, out: Path, tools: Tools, *, only: Optional[list[str]] = None,
        clock: Callable[[], float] = time.monotonic, log: Callable[[str], None] = print) -> dict[str, dict]:
    problems = parity_problems(manifest, tools.build_tags)
    if problems:
        raise SystemExit("refusing to render; the service and the compiler disagree:\n  " + "\n  ".join(problems))
    out.mkdir(parents=True, exist_ok=True)
    env = dict(tools.environment)
    # A finished render is reused only when it was made from the same request
    # and configuration as this run would make it. Otherwise the directory
    # holds another experiment: mixing it in would compare two models while
    # claiming to compare two prompts (review of #191, 2026-11-28).
    existing = read_results(out)
    want = {e["id"]: fingerprint(e["input_version"], e["seed"], env) for e in manifest["entries"]}
    stale = sorted(i for i, r in existing.items() if r["status"] == "ok" and i in want
                   and fingerprint(r.get("input_version", ""), r.get("seed"), r.get("environment") or {}) != want[i])
    if stale:
        raise SystemExit(
            f"refusing to continue in {out}: {len(stale)} finished render(s) were made with a different request "
            f"or configuration ({', '.join(stale[:4])}{'…' if len(stale) > 4 else ''}). Use a new output directory "
            "(BENCH_OUT=/bench/<name>) or move this one aside.")
    (out / "environment.json").write_text(json.dumps(env, indent=2), encoding="utf-8")
    done = {i for i, r in existing.items() if r["status"] == "ok"}
    todo = [e for e in manifest["entries"] if e["id"] not in done and (not only or e["brief"] in only)]
    log(f"{len(done)} done, {len(todo)} to render")
    with (out / "results.jsonl").open("a", encoding="utf-8") as fh:
        for n, e in enumerate(todo, 1):
            work = out / "tmp" / e["id"]
            mp3 = out / "audio" / f"{e['id']}.mp3"
            rec = {"id": e["id"], "brief": e["brief"], "seed": e["seed"], "arm": e["arm"],
                   "input_version": e["input_version"], "manifest_version": manifest.get("manifest_version"),
                   "environment": env}
            t0 = clock()
            try:
                wav = tools.render(e["request"], work, seed=e["seed"], tag_style="v2")
                t1 = clock()
                rec["master"] = tools.master(wav, mp3)
                rec["diagnostics"] = diagnose(tools, wav, mp3, e["request"])
                rec.update(status="ok", audio=str(mp3.relative_to(out)),
                           render_s=round(t1 - t0, 1), total_s=round(clock() - t0, 1))
            except Exception as err:
                rec.update(status="failed", reason=f"{type(err).__name__}: {str(err)[:300]}",
                           total_s=round(clock() - t0, 1))
            finally:
                shutil.rmtree(work, ignore_errors=True)
            fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
            fh.flush()
            log(f"[{n}/{len(todo)}] {e['id']} {rec['status']} {rec.get('total_s')}s" +
                (f" — {rec['reason']}" if rec["status"] == "failed" else ""))
    return read_results(out)


# --------------------------------------------------------------------- pages
def blind_key(manifest: dict, results: dict[str, dict], key_seed: int) -> dict:
    """Which of X/Y is which arm, per pair, and the order pairs are played in. Decided once, then kept."""
    rng = random.Random(key_seed)
    out = []
    for p in pairs(manifest):
        a, b = results.get(p["A"]["id"], {}), results.get(p["B"]["id"], {})
        token = hashlib.sha256(f"{key_seed}:{p['brief']}:{p['seed']}".encode()).hexdigest()[:10]
        entry = {"pair": token, "brief": p["brief"], "seed": p["seed"]}
        if a.get("status") == "ok" and b.get("status") == "ok":
            x_is_a = rng.random() < 0.5
            entry.update(comparable=True, X=p["A"]["id"] if x_is_a else p["B"]["id"],
                         Y=p["B"]["id"] if x_is_a else p["A"]["id"])
        else:
            entry.update(comparable=False, missing=[i for i, r in ((p["A"]["id"], a), (p["B"]["id"], b))
                                                    if r.get("status") != "ok"])
        out.append(entry)
    rng.shuffle(out)
    return {"key_seed": key_seed, "manifest_version": manifest.get("manifest_version"), "pairs": out}


def build_pages(manifest: dict, out: Path, tools: Tools, *, key_seed: Optional[int] = None) -> dict:
    results = read_results(out)
    key_path = out / "key.json"
    if key_path.exists():
        key = json.loads(key_path.read_text(encoding="utf-8"))
        known = {(p["brief"], p["seed"]) for p in key["pairs"] if p["comparable"]}
        fresh = blind_key(manifest, results, key["key_seed"])
        # A pair that became comparable since (a retried render) joins; none is reshuffled.
        for p in fresh["pairs"]:
            if p["comparable"] and (p["brief"], p["seed"]) not in known:
                old = next(q for q in key["pairs"] if (q["brief"], q["seed"]) == (p["brief"], p["seed"]))
                old.update(p)
    else:
        key = blind_key(manifest, results, key_seed if key_seed is not None else random.SystemRandom().randrange(1 << 30))
    key_path.write_text(json.dumps(key, indent=2), encoding="utf-8")

    listen = out / "listen"
    listen.mkdir(parents=True, exist_ok=True)
    gains = {}
    for p in key["pairs"]:
        if not p["comparable"]:
            continue
        for side in ("X", "Y"):
            src = out / results[p[side]]["audio"]
            dst = listen / f"{p['pair']}-{side}.mp3"
            lufs = tools.loudness(src)
            db = round(TARGET_LUFS - lufs, 2) if lufs is not None else 0.0
            # Gain only: the same song quieter or louder, its dynamics intact.
            tools.gain_copy(src, dst, db)
            gains[f"{p['pair']}-{side}"] = {"lufs": lufs, "gain_db": db}
    (out / "gains.json").write_text(json.dumps(gains, indent=2), encoding="utf-8")
    (listen / "index.html").write_text(blind_page(manifest, key), encoding="utf-8")
    (out / "report.html").write_text(engineer_page(manifest, results, key, gains), encoding="utf-8")
    return key


def blind_page(manifest: dict, key: dict) -> str:
    """No arm, no request, no file name that says A or B."""
    lyrics = {e["brief"]: e["request"].get("lyrics", "") for e in manifest["entries"] if e["arm"] == "A"}
    sung = {b: "\n".join(l for l in t.splitlines() if l.strip() and not re.fullmatch(r"\s*\[.*\]\s*", l))
            for b, t in lyrics.items()}
    data = {
        "keySeed": key["key_seed"], "manifest": key.get("manifest_version"),
        "pairs": [{"pair": p["pair"], "lyrics": sung.get(p["brief"], "")} for p in key["pairs"] if p["comparable"]],
        "criteria": [{"id": c, "name": n, "help": h} for c, n, h in CRITERIA],
        "issues": [{"id": i, "name": n} for i, n in ISSUES],
    }
    return BLIND_HTML.replace("__DATA__", json.dumps(data, ensure_ascii=False).replace("</", "<\\/"))


def engineer_page(manifest: dict, results: dict, key: dict, gains: dict) -> str:
    rows = []
    for e in manifest["entries"]:
        r = results.get(e["id"], {})
        d = r.get("diagnostics", {})
        def v(k):
            c = d.get(k)
            if not c:
                return ""
            return "?" if c["confidence"] == "unknown" else html.escape(str(c["value"]))
        audio = f"<audio controls preload=none src='{html.escape(r['audio'])}'></audio>" if r.get("status") == "ok" else ""
        rows.append(
            f"<tr class='{r.get('status', 'pending')}'><td>{html.escape(e['id'])}</td><td>{e['arm']}</td>"
            f"<td>{html.escape(r.get('status', 'not run'))}</td><td>{r.get('render_s', '')}</td><td>{r.get('total_s', '')}</td>"
            f"<td>{v('duration_s')}</td><td>{v('lyric_coverage')}</td><td>{v('section_word_sung')}</td>"
            f"<td>{v('clipped_samples')}</td><td>{v('tail_silence_s')}</td>"
            f"<td class=small>{html.escape(r.get('reason', ''))}</td><td>{audio}</td></tr>"
            f"<tr><td colspan=12 class=small><code>{html.escape(e['expected_tags_v2'])}</code></td></tr>")
    env = next((r.get("environment") for r in results.values() if r.get("environment")), {})
    ok = sum(1 for r in results.values() if r.get("status") == "ok")
    failed = sum(1 for r in results.values() if r.get("status") == "failed")
    return (
        "<!doctype html><meta charset=utf-8><title>production bench — engineer view</title>"
        "<style>body{font:13px system-ui;margin:24px;max-width:1400px}table{border-collapse:collapse;width:100%}"
        "td,th{padding:4px 6px;border-bottom:1px solid #eee;text-align:left;vertical-align:top}.small{color:#666;font-size:12px}"
        "tr.failed td{background:#fff1f1}.warn{background:#fff6d6;padding:8px 12px;border-radius:6px}</style>"
        "<h1>Production bench — engineer view</h1>"
        "<p class=warn><b>Unblinded.</b> This page says which render is A and which is B. "
        "Listen on <a href='listen/index.html'>listen/index.html</a> first.</p>"
        f"<p>{ok} rendered, {failed} failed, of {len(manifest['entries'])}. Manifest {html.escape(str(manifest.get('manifest_version')))}. "
        f"Diagnostics are clues: <b>?</b> means it could not be measured and does not count either way.</p>"
        f"<pre class=small>{html.escape(json.dumps(env, indent=1))}</pre>"
        "<table><tr><th>render<th>arm<th>status<th>render s<th>total s<th>length s<th>lyric heard<th>section word sung"
        "<th>clipped<th>tail silence<th>failure<th></tr>" + "".join(rows) + "</table>"
    )


# ---------------------------------------------------------------------- score
LANGUAGE_WORDS = {
    "zh": ("中文", "汉语", "漢語", "普通话", "国语", "chinese", "mandarin", "zh"),
    "ja": ("日语", "日語", "日本語", "japanese", "ja"),
    "en": ("英语", "英語", "english", "en"),
}


def knows(languages: str, lang: str) -> bool:
    text = (languages or "").lower()
    return any(w in text for w in LANGUAGE_WORDS.get(lang, (lang,)))


def score(key: dict, judgments: list[dict], *, languages: Optional[dict[str, str]] = None,
          iterations: int = 2000, seed: int = 7) -> dict:
    """
    Unblind and aggregate (spec step 2; review of #191).

    Two results come out, and only one of them is a conclusion:

      formal  — a pair is decided only by two independent reviewers who
                agree, at least one of whom knows the song's language; a
                disagreement needs a third (three different picks: a tie).
                Anything short of that is `pending`, never a win. A brief is
                decided only when both its seeds are; a brief with a render
                missing on either arm stays in the denominator and is never
                a B win. Pending briefs stay in the denominator too.
      preview — whatever the votes so far say, for watching a review in
                progress. Not a result.

    Counts of missing renders, missing reviews, pending, ties and decided
    pairs are reported separately so none of them hides in a rate.
    """
    languages = languages or {}
    by_pair = {p["pair"]: p for p in key["pairs"]}
    arm_of = lambda p, side: "A" if p[side].endswith("-A") else "B"  # noqa: E731
    votes: dict[str, dict[str, list[tuple[str, str]]]] = {}   # pair -> crit -> [(reviewer, arm|tie)]
    reviewers: dict[str, set[str]] = {}
    for j in judgments:
        who = (j.get("reviewer") or "").strip() or f"anonymous-{id(j)}"
        for token, v in (j.get("pairs") or {}).items():
            p = by_pair.get(token)
            if not p or not p.get("comparable"):
                continue
            reviewers.setdefault(token, set())
            crits = v.get("criteria") or {}
            if crits:
                reviewers[token].add(who)
            for crit, pick in crits.items():
                arm = arm_of(p, pick) if pick in ("X", "Y") else "tie"
                # One vote per reviewer per pair: a re-export replaces, never adds.
                cur = [x for x in votes.setdefault(token, {}).setdefault(crit, []) if x[0] != who]
                votes[token][crit] = cur + [(who, arm)]
    fluent = {who for j in judgments for who in [(j.get("reviewer") or "").strip()]
              if who and any(knows(j.get("languages", ""), l) for l in ("zh", "ja", "en"))}
    lang_of_reviewer = {(j.get("reviewer") or "").strip(): j.get("languages", "") for j in judgments}

    def formal_pair(p: dict, crit: str) -> tuple[str, str]:
        vs = votes.get(p["pair"], {}).get(crit, [])
        if len(vs) < 2:
            return "pending", "needs two independent reviews"
        lang = languages.get(p["brief"]) or p["brief"].split("-")[0]
        if not any(knows(lang_of_reviewer.get(w, ""), lang) for w, _ in vs):
            return "pending", f"no reviewer who knows {lang}"
        picks = [a for _, a in vs]
        if picks[0] == picks[1]:
            return picks[0], "agreed"
        if len(picks) < 3:
            return "pending", "disagreement: needs a third reviewer"
        counts = {x: picks[:3].count(x) for x in set(picks[:3])}
        top = max(counts.values())
        return (next(x for x, c in counts.items() if c == top), "third reviewer") if top >= 2 else ("tie", "three ways")

    def preview_pair(p: dict, crit: str) -> str:
        picks = [a for _, a in votes.get(p["pair"], {}).get(crit, [])]
        if not picks:
            return "none"
        net = picks.count("B") - picks.count("A")
        return "B" if net > 0 else "A" if net < 0 else "tie"

    briefs = sorted({p["brief"] for p in key["pairs"]})
    out: dict = {}
    rng = random.Random(seed)
    for crit, *_ in CRITERIA:
        counts = {"missing_render": 0, "missing_review": 0, "pending": 0, "tie": 0, "decided": 0}
        formal: dict[str, str] = {}
        preview: dict[str, str] = {}
        why: dict[str, list[str]] = {}
        for b in briefs:
            ps = [p for p in key["pairs"] if p["brief"] == b]
            fr, pr, missing_b = [], [], False
            for p in ps:
                if not p.get("comparable"):
                    counts["missing_render"] += 1
                    missing = p.get("missing", [])
                    missing_b = missing_b or any(m.endswith("-B") for m in missing)
                    a_only = any(m.endswith("-B") for m in missing) and not any(m.endswith("-A") for m in missing)
                    fr.append("A" if a_only else "tie")
                    pr.append("A" if a_only else "tie")
                    why.setdefault(b, []).append(f"seed {p['seed']}: render missing ({', '.join(missing)})")
                    continue
                r, reason = formal_pair(p, crit)
                if not votes.get(p["pair"], {}).get(crit):
                    counts["missing_review"] += 1
                elif r == "pending":
                    counts["pending"] += 1
                elif r == "tie":
                    counts["tie"] += 1
                else:
                    counts["decided"] += 1
                if r == "pending":
                    why.setdefault(b, []).append(f"seed {p['seed']}: {reason}")
                fr.append(r)
                pr.append(preview_pair(p, crit))

            def combine(rs: list[str]) -> str:
                net = rs.count("B") - rs.count("A")
                return "B" if net > 0 else "A" if net < 0 else "tie"

            formal[b] = "pending" if "pending" in fr else combine(fr)
            preview[b] = combine([r for r in pr if r != "none"]) if any(r != "none" for r in pr) else "none"
            if missing_b:
                # A candidate that did not deliver on every seed cannot win the brief.
                formal[b] = "tie" if formal[b] == "B" else formal[b]
                preview[b] = "tie" if preview[b] == "B" else preview[b]

        n = len(briefs)
        vals = [1 if formal[b] == "B" else -1 if formal[b] == "A" else 0 for b in briefs]
        diffs = sorted(sum(rng.choice(vals) for _ in range(n)) / n for _ in range(iterations)) if n else [0.0]
        out[crit] = {
            "briefs": n,
            "formal": {
                "per_brief": formal,
                "B": vals.count(1), "A": vals.count(-1),
                "tie": sum(1 for b in briefs if formal[b] == "tie"),
                "pending": sum(1 for b in briefs if formal[b] == "pending"),
                "b_win_rate": round(vals.count(1) / n, 3) if n else None,
                "diff": round(sum(vals) / n, 3) if n else None,
                "ci95": [round(diffs[int(0.025 * iterations)], 3), round(diffs[int(0.975 * iterations) - 1], 3)] if n else None,
                "complete": n > 0 and all(formal[b] != "pending" for b in briefs),
            },
            "preview": {"per_brief": preview, "note": "votes so far; not a result"},
            "pairs": counts,
            "why_pending": why,
        }
    out["reviewers"] = sorted({w for ws in reviewers.values() for w in ws})
    out["reviewers_with_a_language"] = sorted(fluent)
    return out


# ----------------------------------------------------------------------- main
def main(argv: list[str]) -> None:
    cmd = argv[1] if len(argv) > 1 else "run"
    manifest = load_manifest()
    if cmd == "run":
        import app
        tools = service_tools()
        # v15 always builds v2 tags (render: `tag_style or "v2"`); TAG_STYLE only
        # steers the v1 engine. Warn only when production is not on the v2 path.
        if app.ENGINE != "v15" and app.TAG_STYLE != "v2":
            print(f"note: the service runs ENGINE={app.ENGINE} TAG_STYLE={app.TAG_STYLE}, i.e. v1 tags; the bench "
                  "renders with v2 tags, so results do not describe what production sends.", flush=True)
        only = [a.split("=", 1)[1].split(",") for a in argv if a.startswith("--only=")]
        app.get_whisper()
        run(manifest, OUT, tools, only=only[0] if only else None)
        build_pages(manifest, OUT, tools)
        print(f"wrote {OUT / 'listen' / 'index.html'} (blind) and {OUT / 'report.html'} (unblinded)")
    elif cmd == "pages":
        build_pages(manifest, OUT, service_tools())
    elif cmd == "score":
        key = json.loads((OUT / "key.json").read_text(encoding="utf-8"))
        judgments = [json.loads(Path(p).read_text(encoding="utf-8")) for p in argv[2:]]
        result = score(key, judgments, languages={e["brief"]: e["language"] for e in manifest["entries"]})
        (OUT / "score.json").write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8")
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        raise SystemExit(f"unknown command {cmd!r}: run | pages | score <judgments.json>...")


BLIND_HTML = r"""<!doctype html><html lang=zh-CN><meta charset=utf-8>
<meta name=viewport content="width=device-width,initial-scale=1">
<title>盲听 — 制作方案 A/B</title>
<style>
:root{--ink:#1f1d1a;--muted:#6b665e;--line:#e7e2da;--bg:#faf8f4;--card:#fff;--accent:#c2410c}
body{font:15px/1.6 system-ui,-apple-system,"PingFang SC","Hiragino Sans",sans-serif;margin:0;background:var(--bg);color:var(--ink)}
main{max-width:860px;margin:0 auto;padding:24px 16px 80px}
h1{font-size:22px;margin:0 0 4px}.muted{color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}
.players{display:grid;grid-template-columns:1fr 1fr;gap:12px}@media(max-width:560px){.players{grid-template-columns:1fr}}
audio{width:100%}.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
fieldset{border:0;padding:0;margin:8px 0}legend{font-weight:600}
label.pick{border:1px solid var(--line);border-radius:999px;padding:4px 12px;cursor:pointer}
label.pick:has(input:checked){border-color:var(--accent);background:#fff3ea}
label.pick input{margin-right:4px}
details{margin-top:8px}pre{white-space:pre-wrap;font:13px/1.7 inherit;background:#f4f1ec;padding:8px;border-radius:8px}
table{width:100%;border-collapse:collapse}td{padding:4px}input[type=text]{width:100%;box-sizing:border-box;padding:6px;border:1px solid var(--line);border-radius:6px}
button{font:inherit;padding:6px 14px;border-radius:8px;border:1px solid var(--line);background:#fff;cursor:pointer}
button.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
.bar{position:sticky;bottom:0;background:var(--bg);border-top:1px solid var(--line);padding:10px 16px}
</style>
<main>
<h1>盲听：同一份歌词、同一个种子的两版</h1>
<p class=muted>每一组的 X 和 Y 只差在制作方式上，顺序随机，响度已对齐。先整首听完再判断。每个判断尽量记一个能支撑它的时间点（点「记下当前时间」会填入正在播放的位置）。</p>
<div class=card>
  <div class=row><label>评审人 <input type=text id=who style="width:12em"></label>
  <label>熟悉的语言 <input type=text id=langs placeholder="如：中文、日语" style="width:12em"></label></div>
</div>
<div id=pairs></div>
</main>
<div class=bar><div class=row style="max-width:860px;margin:0 auto">
<span id=progress class=muted></span><span style="flex:1"></span>
<button id=import>导入</button><button class=primary id=export>导出评审结果</button>
<input type=file id=file accept=application/json hidden></div></div>
<script>
const D = __DATA__;
const store = 'prodbench:' + D.manifest + ':' + D.keySeed;
let S = {}; try { S = JSON.parse(localStorage.getItem(store) || '{}'); } catch {}
S.pairs = S.pairs || {};
const save = () => { try { localStorage.setItem(store, JSON.stringify(S)); } catch {} progress(); };
const el = (t, a = {}, ...c) => { const e = document.createElement(t); Object.assign(e, a); e.append(...c); return e; };
function progress() {
  const done = D.pairs.filter(p => (S.pairs[p.pair]?.criteria || {}).whole).length;
  document.getElementById('progress').textContent = `已完成 ${done} / ${D.pairs.length} 组`;
}
function pickRow(p, crit) {
  const fs = el('fieldset'); fs.append(el('legend', { textContent: crit.name, title: crit.help }));
  fs.append(el('div', { className: 'muted', textContent: crit.help, style: 'font-size:13px' }));
  const row = el('div', { className: 'row' });
  for (const [v, t] of [['X', 'X 更好'], ['Y', 'Y 更好'], ['same', '听不出差异']]) {
    const i = el('input', { type: 'radio', name: p.pair + crit.id, value: v, checked: (S.pairs[p.pair]?.criteria || {})[crit.id] === v });
    i.onchange = () => { const s = S.pairs[p.pair] ||= {}; (s.criteria ||= {})[crit.id] = v; save(); };
    row.append(el('label', { className: 'pick' }, i, t));
  }
  fs.append(row); return fs;
}
function notes(p, players) {
  const wrap = el('div'); const list = el('table');
  const s = () => (S.pairs[p.pair] ||= {});
  const draw = () => {
    list.replaceChildren();
    (s().notes || []).forEach((n, i) => {
      const del = el('button', { textContent: '删除' }); del.onclick = () => { s().notes.splice(i, 1); save(); draw(); };
      list.append(el('tr', {}, el('td', { textContent: `${n.side} ${n.time}` }),
        el('td', { textContent: D.issues.find(x => x.id === n.issue)?.name || n.issue }), el('td', { textContent: n.text }), el('td', {}, del)));
    });
  };
  const side = el('select'); side.append(el('option', { value: 'X', textContent: 'X' }), el('option', { value: 'Y', textContent: 'Y' }));
  const time = el('input', { type: 'text', placeholder: '1:23', style: 'width:5em' });
  const now = el('button', { textContent: '记下当前时间' });
  now.onclick = () => { const a = players[side.value]; const t = Math.floor(a.currentTime); time.value = `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`; };
  const issue = el('select'); for (const x of D.issues) issue.append(el('option', { value: x.id, textContent: x.name }));
  const text = el('input', { type: 'text', placeholder: '听到了什么' });
  const add = el('button', { textContent: '添加' });
  add.onclick = () => { if (!time.value) return; (s().notes ||= []).push({ side: side.value, time: time.value, issue: issue.value, text: text.value }); text.value = ''; save(); draw(); };
  wrap.append(el('div', { className: 'row' }, side, time, now, issue), el('div', { className: 'row', style: 'margin-top:6px' }, text, add), list);
  draw(); return wrap;
}
const root = document.getElementById('pairs');
D.pairs.forEach((p, n) => {
  const players = { X: el('audio', { controls: true, preload: 'none', src: `${p.pair}-X.mp3` }), Y: el('audio', { controls: true, preload: 'none', src: `${p.pair}-Y.mp3` }) };
  players.X.onplay = () => players.Y.pause(); players.Y.onplay = () => players.X.pause();
  const card = el('section', { className: 'card' });
  card.append(el('h2', { textContent: `第 ${n + 1} 组`, style: 'font-size:17px;margin:0 0 8px' }),
    el('div', { className: 'players' }, el('div', {}, el('b', { textContent: 'X' }), players.X), el('div', {}, el('b', { textContent: 'Y' }), players.Y)),
    el('details', {}, el('summary', { textContent: '歌词' }), el('pre', { textContent: p.lyrics })));
  for (const c of D.criteria) card.append(pickRow(p, c));
  card.append(el('fieldset', {}, el('legend', { textContent: '问题与时间点' }), notes(p, players)));
  root.append(card);
});
document.getElementById('export').onclick = () => {
  const who = document.getElementById('who').value.trim(); if (!who) { alert('先填评审人'); return; }
  const body = { reviewer: who, languages: document.getElementById('langs').value, manifest: D.manifest, keySeed: D.keySeed, exportedAt: new Date().toISOString(), pairs: S.pairs };
  const a = el('a', { href: URL.createObjectURL(new Blob([JSON.stringify(body, null, 2)], { type: 'application/json' })), download: `judgments-${who}.json` });
  a.click();
};
document.getElementById('import').onclick = () => document.getElementById('file').click();
document.getElementById('file').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; const j = JSON.parse(await f.text()); S.pairs = j.pairs || {}; save(); location.reload(); };
progress();
</script></html>
"""

if __name__ == "__main__":
    main(sys.argv)
