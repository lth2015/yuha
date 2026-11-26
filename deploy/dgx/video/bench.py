#!/usr/bin/env python3
"""
P0 bench for the clip service (docs/AI_SCENE_MV_SPEC.md §8, tickets T1).

Run on dgxv, next to the service:
    python3 bench.py                       # cold start + 5 warm runs per config
    python3 bench.py --runs 30 --only v4   # the chosen config, 30 runs

What it records, per run: queue wait, GPU generation time, end-to-end time,
clip length, the service's peak torch allocation, and the host's peak used
memory sampled from /proc/meminfo (DGX Spark memory is unified, so that is the
number that says whether music can still run beside it), plus failures and
their reason. A cold start restarts the container and times the model load.

Output: bench-<stamp>.jsonl (every run) and bench-<stamp>.md (the table for
the spec). The prompts are fixed scene descriptions written for the bench —
no user's words, photos or songs.
"""
from __future__ import annotations

import argparse
import json
import os
import platform
import statistics
import subprocess
import threading
import time
import urllib.request
from pathlib import Path

CONFIGS = {
    "v4": {"width": 480, "height": 832, "seconds": 4},   # vertical, the first version's shot
    "v8": {"width": 480, "height": 832, "seconds": 8},
    "h4": {"width": 832, "height": 480, "seconds": 4},   # horizontal, for comparison only
    "h8": {"width": 832, "height": 480, "seconds": 8},
}
PROMPTS = [
    "a rainy city street at night, neon reflections on wet asphalt, slow dolly forward, cinematic",
    "a quiet beach at sunset, gentle waves, warm light, slow pan, film grain",
    "a soft watercolour illustration of a small town in spring, petals drifting, calm camera",
]


def env(name: str, default: str = "") -> str:
    if os.environ.get(name):
        return os.environ[name]
    p = Path(__file__).with_name(".env")
    if p.exists():
        for line in p.read_text().splitlines():
            if line.startswith(f"{name}="):
                return line.split("=", 1)[1]
    return default


BASE = f"http://127.0.0.1:{env('HOST_PORT', '8100')}"
KEY = env("YUHA_API_KEY")


def call(method: str, path: str, body: dict | None = None, timeout: float = 30) -> dict:
    req = urllib.request.Request(BASE + path, method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"authorization": f"Bearer {KEY}", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"status": "rejected", "http": e.code, **json.loads(e.read() or b"{}")}


class MemSampler:
    """Peak used host memory (GB) while a run is in flight."""

    def __init__(self) -> None:
        self.peak = 0.0
        self._stop = threading.Event()

    @staticmethod
    def used_gb() -> float:
        info = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            k, v = line.split(":", 1)
            info[k] = int(v.split()[0])
        return (info["MemTotal"] - info["MemAvailable"]) / 1e6

    def __enter__(self):
        def loop():
            while not self._stop.is_set():
                self.peak = max(self.peak, self.used_gb())
                time.sleep(0.5)
        self._t = threading.Thread(target=loop, daemon=True)
        self._t.start()
        return self

    def __exit__(self, *_):
        self._stop.set()
        self._t.join()


def wait_loaded(limit: float = 3600) -> float:
    t0 = time.time()
    while time.time() - t0 < limit:
        try:
            h = json.loads(urllib.request.urlopen(BASE + "/healthz", timeout=5).read())
            if h.get("model_loaded"):
                return time.time() - t0
            if h.get("model_error"):
                raise SystemExit(f"model failed to load: {h['model_error']}")
        except (OSError, ValueError):
            pass
        time.sleep(2)
    raise SystemExit("model did not load in time")


def one(cfg_name: str, cfg: dict, i: int, steps: int | None, timeout: float) -> dict:
    body = {**cfg, "prompt": PROMPTS[i % len(PROMPTS)], "fps": 24, "seed": 1000 + i}
    if steps:
        body["steps"] = steps
    t0 = time.time()
    job: dict = {}
    mem = MemSampler()
    try:
        with mem:
            job = call("POST", "/v1/clips", body)
            while job.get("status") in ("queued", "running") and time.time() - t0 < timeout:
                time.sleep(1)
                job = call("GET", f"/v1/clips/{job['id']}")
        if job.get("status") in ("queued", "running"):
            call("POST", f"/v1/clips/{job['id']}/cancel")
            # A running clip stops at its next step: wait for that, or the next run is timed with it.
            for _ in range(600):
                if call("GET", f"/v1/clips/{job['id']}").get("status") not in ("queued", "running"):
                    break
                time.sleep(1)
            job["status"], job["error"] = "failed", "bench_timeout"
    except (OSError, ValueError) as e:  # URLError, a timeout, a body that is not JSON
        job = {**job, "status": "failed", "error": f"service_unreachable: {type(e).__name__}"}
    return {
        "config": cfg_name, "run": i, **cfg, "steps": job.get("steps", steps), "frames": job.get("frames"),
        "status": job.get("status"), "error": job.get("error"),
        "wall_seconds": round(time.time() - t0, 1),
        "generation_seconds": job.get("generation_seconds"), "total_seconds": job.get("total_seconds"),
        "clip_seconds": job.get("clip_seconds"), "peak_torch_gb": job.get("peak_memory_gb"),
        "peak_host_used_gb": round(mem.peak, 1), "model": job.get("model"),
    }


def pct(xs: list[float], p: float) -> float | None:
    if not xs:
        return None
    xs = sorted(xs)
    k = (len(xs) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return round(xs[lo] + (xs[hi] - xs[lo]) * (k - lo), 1)


def host_facts() -> list[str]:
    def sh(cmd: str) -> str:
        try:
            return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=20).stdout.strip()
        except Exception:
            return "?"
    image_cmd = "docker inspect --format '{{.Config.Image}}@{{.Image}}' yuha-video"
    cuda_cmd = "nvidia-smi | grep -o 'CUDA Version: [0-9.]*'"
    total_gb = round(int(Path("/proc/meminfo").read_text().split()[1]) / 1e6, 1)
    return [
        f"- host: {platform.node()} {platform.machine()} — {sh('uname -r')}",
        f"- GPU: {sh('nvidia-smi --query-gpu=name,driver_version --format=csv,noheader')}",
        f"- CUDA (driver): {sh(cuda_cmd)}",
        f"- memory total: {total_gb} GB",
        f"- image: {sh(image_cmd)}",
        f"- service env: VIDEO_MODEL={env('VIDEO_MODEL', '(default)')} VIDEO_PIPELINE={env('VIDEO_PIPELINE', '(default)')} "
        f"VIDEO_DTYPE={env('VIDEO_DTYPE', 'bfloat16')} VIDEO_STEPS={env('VIDEO_STEPS', '40')}",
        "- model audio: none generated by this pipeline; every clip is checked silent by the service",
    ]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", type=int, default=5, help="warm runs per config")
    ap.add_argument("--only", nargs="*", choices=list(CONFIGS), help="configs to run (default: all)")
    ap.add_argument("--steps", type=int, help="override the service's default steps")
    ap.add_argument("--no-cold", action="store_true", help="skip the container restart")
    ap.add_argument("--timeout", type=float, default=1800, help="seconds before one run counts as failed")
    a = ap.parse_args()
    if not KEY:
        raise SystemExit("YUHA_API_KEY not set (looked in the environment and ./.env)")

    stamp = time.strftime("%Y%m%d-%H%M%S")
    out = Path(__file__).with_name(f"bench-{stamp}.jsonl")
    rows: list[dict] = []
    load_seconds = None
    if not a.no_cold:
        subprocess.run(["docker", "restart", "yuha-video"], check=True, capture_output=True)
        time.sleep(3)
        load_seconds = round(wait_loaded(), 1)
        print(f"cold start: model loaded in {load_seconds}s")
    else:
        wait_loaded()

    names = a.only or list(CONFIGS)
    for n, name in enumerate(names):
        # The very first clip after a restart is the cold one; it is kept apart from the warm numbers.
        runs = ([("cold", 0)] if n == 0 and not a.no_cold else []) + [("warm", i + 1) for i in range(a.runs)]
        for kind, i in runs:
            r = {**one(name, CONFIGS[name], i, a.steps, a.timeout), "kind": kind}
            rows.append(r)
            with out.open("a") as f:
                f.write(json.dumps(r) + "\n")
            print(f"{name} {kind} #{i}: {r['status']} gen={r['generation_seconds']}s "
                  f"wall={r['wall_seconds']}s torch={r['peak_torch_gb']}GB host={r['peak_host_used_gb']}GB"
                  + (f" ({r['error']})" if r["error"] else ""))

    md = [f"# Clip bench {stamp}", "", *host_facts()]
    if load_seconds is not None:
        md.append(f"- cold start (container restart → model loaded): {load_seconds}s")
    md += ["", "| config | size | clip s | frames | steps | warm runs | ok | failed | gen P50 | gen P95 | wall P50 | wall P95 | peak torch GB | peak host used GB | cold first clip gen s |",
           "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |"]
    for name in names:
        warm = [r for r in rows if r["config"] == name and r["kind"] == "warm"]
        ok = [r for r in warm if r["status"] == "succeeded"]
        cold = next((r for r in rows if r["config"] == name and r["kind"] == "cold"), None)
        c = CONFIGS[name]
        md.append("| " + " | ".join(str(x) for x in [
            name, f"{c['width']}×{c['height']}", c["seconds"], warm[0]["frames"] if warm else "", warm[0]["steps"] if warm else "",
            len(warm), len(ok), len(warm) - len(ok),
            pct([r["generation_seconds"] for r in ok], .5), pct([r["generation_seconds"] for r in ok], .95),
            pct([r["wall_seconds"] for r in ok], .5), pct([r["wall_seconds"] for r in ok], .95),
            max((r["peak_torch_gb"] for r in ok if r["peak_torch_gb"] is not None), default="n/a"), max((r["peak_host_used_gb"] for r in warm), default=""),
            cold["generation_seconds"] if cold else "",
        ]) + " |")
    failures = [r for r in rows if r["status"] != "succeeded"]
    if failures:
        md += ["", "Failures:", *[f"- {r['config']} {r['kind']} #{r['run']}: {r['error']}" for r in failures]]
    md += ["", "Clips are kept on the box under data/clips for RETENTION_HOURS; look at them before trusting any number above.",
           f"Raw rows: {out.name}", ""]
    if rows and statistics.mean([1 if r["status"] == "succeeded" else 0 for r in rows]) < 1:
        md.append("**Not every run succeeded.** A config with failures is not a candidate until the reason is understood.")
    Path(__file__).with_name(f"bench-{stamp}.md").write_text("\n".join(md) + "\n")
    print("\n".join(md))


if __name__ == "__main__":
    main()
