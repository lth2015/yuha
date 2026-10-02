#!/usr/bin/env python3
"""
YUHA music service client — call the ACE-Step service on the DGX from anywhere.

Python 3.8+, standard library only (nothing to pip install).

  export YUHA_API_KEY=...          # from ~/yuha-spark/.env on the DGX
  python3 yuha_music_client.py --health
  python3 yuha_music_client.py --prompt "城市夜晚，轻快的 city pop，女声" \
      --lyrics-file lyrics.txt --duration 60 --out song.mp3
  python3 yuha_music_client.py --prompt "calm lofi for studying" --instrumental --duration 30

What it does: GET /healthz -> POST /v1/jobs -> poll GET /v1/jobs/{id} until done
-> download the mp3.

The service signs audio links with its own AUDIO_BASE_URL, which is the
intranet address (http://10.5.0.7:8583). From outside that address is not
reachable, so the download host is rewritten to --base. The signature covers
only the job id and the expiry, so the rewritten link is still valid.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

DEFAULT_BASE = "http://121.101.82.116:8583"


class ApiError(Exception):
    def __init__(self, status: int, body: str, retry_after: int | None = None):
        super().__init__(f"HTTP {status}: {body[:300]}")
        self.status, self.body, self.retry_after = status, body, retry_after


def request(method: str, url: str, *, key: str | None = None, body: dict | None = None,
            headers: dict | None = None, timeout: float = 30.0) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    h = {"accept": "application/json", **(headers or {})}
    if data is not None:
        h["content-type"] = "application/json"
    if key:
        h["authorization"] = f"Bearer {key}"
    req = urllib.request.Request(url, data=data, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return json.loads(r.read().decode() or "{}")
    except urllib.error.HTTPError as e:
        ra = e.headers.get("Retry-After")
        raise ApiError(e.code, e.read().decode(errors="replace"), int(ra) if ra and ra.isdigit() else None)


def rehost(audio_url: str, base: str) -> str:
    """Keep path + signed query, swap scheme/host/port for the one we can reach."""
    a, b = urllib.parse.urlsplit(audio_url), urllib.parse.urlsplit(base)
    return urllib.parse.urlunsplit((b.scheme, b.netloc, a.path, a.query, ""))


def download(url: str, out: str, timeout: float = 120.0) -> int:
    req = urllib.request.Request(url, headers={"accept": "audio/mpeg"})
    with urllib.request.urlopen(req, timeout=timeout) as r, open(out, "wb") as f:
        total = 0
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            f.write(chunk)
            total += len(chunk)
    return total


def fmt(s: float | None) -> str:
    return "-" if s is None else f"{s:.1f}s"


def main() -> int:
    p = argparse.ArgumentParser(description="Generate a song on the YUHA DGX music service.")
    p.add_argument("--base", default=os.environ.get("YUHA_MUSIC_BASE", DEFAULT_BASE),
                   help=f"service base URL (default {DEFAULT_BASE}, or $YUHA_MUSIC_BASE)")
    p.add_argument("--key", default=os.environ.get("YUHA_API_KEY"),
                   help="API key (default $YUHA_API_KEY; prefer the env var so it stays out of shell history)")
    p.add_argument("--health", action="store_true", help="only check /healthz and exit")
    p.add_argument("--prompt", help="style / mood description (1-1000 chars)")
    p.add_argument("--lyrics", help="lyrics text; use [verse] / [chorus] lines for sections")
    p.add_argument("--lyrics-file", help="read lyrics from a UTF-8 file")
    p.add_argument("--instrumental", action="store_true", help="no vocals")
    p.add_argument("--duration", type=int, default=60, help="seconds, 10-240 (default 60)")
    p.add_argument("--tags", default="", help="comma-separated style tags, e.g. 'city pop,female vocals'")
    p.add_argument("--tempo", choices=["slow", "medium", "fast"])
    p.add_argument("--energy", type=float, help="0.0-1.0")
    p.add_argument("--out", default=None, help="output mp3 path (default yuha_<jobid>.mp3)")
    p.add_argument("--poll", type=float, default=3.0, help="poll interval seconds (default 3)")
    p.add_argument("--max-wait", type=int, default=1800, help="give up after N seconds (default 1800)")
    a = p.parse_args()
    base = a.base.rstrip("/")

    # 1. health (no key needed)
    try:
        h = request("GET", f"{base}/healthz", timeout=10)
    except Exception as e:  # noqa: BLE001
        print(f"✗ cannot reach {base}/healthz: {e}", file=sys.stderr)
        print("  check the port forward / firewall, and that the URL is http (not https)", file=sys.stderr)
        return 2
    print(f"✓ reachable  engine={h.get('engine', '?')}  model_loaded={h.get('model_loaded')}  "
          f"queue={h.get('queue_depth')}  aligner_loaded={h.get('aligner_loaded')}")
    if not h.get("model_loaded"):
        print(f"  model not loaded yet: {h.get('model_error')}", file=sys.stderr)
    if a.health:
        return 0

    if not a.key:
        print("✗ no API key: export YUHA_API_KEY=... (see ~/yuha-spark/.env on the DGX)", file=sys.stderr)
        return 2
    if not a.prompt:
        print("✗ --prompt is required", file=sys.stderr)
        return 2
    lyrics = a.lyrics
    if a.lyrics_file:
        with open(a.lyrics_file, encoding="utf-8") as f:
            lyrics = f.read()
    if not a.instrumental and not (lyrics and lyrics.strip()):
        print("! no lyrics given: the song will be sung with wordless vocals. "
              "Pass --lyrics/--lyrics-file, or --instrumental.", file=sys.stderr)

    body: dict = {
        "prompt": a.prompt,
        "duration_seconds": a.duration,
        "instrumental": a.instrumental,
        "format": "mp3",
    }
    if lyrics and not a.instrumental:
        body["lyrics"] = lyrics
    tags = [t.strip() for t in a.tags.split(",") if t.strip()]
    if tags:
        body["style_tags"] = tags
    if a.tempo:
        body["tempo"] = a.tempo
    if a.energy is not None:
        body["energy"] = a.energy

    # 2. submit (the idempotency key makes a retried submit return the same job)
    idem = f"cli-{uuid.uuid4().hex}"
    t0 = time.time()
    while True:
        try:
            job = request("POST", f"{base}/v1/jobs", key=a.key, body=body,
                          headers={"idempotency-key": idem}, timeout=30)
            break
        except ApiError as e:
            if e.status == 401:
                print("✗ 401 unauthorized: the API key is wrong", file=sys.stderr)
                return 3
            if e.status == 422:
                print(f"✗ 422 rejected input: {e.body}", file=sys.stderr)
                return 3
            if e.status == 429:
                wait = e.retry_after or 60
                print(f"… queue full, retrying in {wait}s")
                time.sleep(wait)
                continue
            print(f"✗ submit failed: {e}", file=sys.stderr)
            return 3
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"… submit network error ({e}); retrying with the same idempotency key")
            time.sleep(5)
    job_id = job["id"]
    print(f"✓ submitted  job={job_id}  status={job['status']}")

    # 3. poll
    last = None
    while True:
        if time.time() - t0 > a.max_wait:
            print(f"✗ gave up after {a.max_wait}s; job {job_id} may still finish on the server", file=sys.stderr)
            return 4
        try:
            job = request("GET", f"{base}/v1/jobs/{job_id}", key=a.key, timeout=30)
        except (ApiError, urllib.error.URLError, TimeoutError) as e:
            print(f"… poll error ({e}); retrying")
            time.sleep(a.poll)
            continue
        st = job["status"]
        if st != last:
            print(f"  {time.time() - t0:6.1f}s  {st}")
            last = st
        if st == "succeeded":
            break
        if st in ("failed", "rejected"):
            print(f"✗ job {st}: {job.get('error')}", file=sys.stderr)
            return 5
        time.sleep(a.poll)

    # 4. download
    url = rehost(job["audio_url"], base)
    out = a.out or f"yuha_{job_id[:8]}.mp3"
    try:
        n = download(url, out)
    except Exception as e:  # noqa: BLE001
        print(f"✗ download failed: {e}\n  url: {url}", file=sys.stderr)
        return 6
    print(f"✓ saved {out}  ({n / 1024:.0f} KB)")
    print(f"  total {time.time() - t0:.1f}s  queue {fmt(job.get('queue_wait_seconds'))}  "
          f"generate {fmt(job.get('generation_seconds'))}  audio {fmt(job.get('audio_seconds'))}")
    print(f"  link (valid ~24h): {url}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
