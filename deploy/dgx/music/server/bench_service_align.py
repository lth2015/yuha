"""
The service's own alignment path, run on this box's recent songs, without
switching the running service (README, "Qwen3-ForcedAligner").

bench_align.py calls the aligners' libraries; this calls `app._align_path`,
so it exercises what the service would do under ALIGN_METHOD: for qwen, the
worker in /opt/qwenv, the fusion with Whisper and every fallback. Run it in a
throwaway container with the method set for that run only:

  docker compose run --rm --no-deps -e ALIGN_METHOD=qwen --entrypoint "" music \
    python bench_service_align.py --songs 3

The running container's .env is not touched. Prints one line per song and the
worker's status; writes nothing.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default="/data")
    ap.add_argument("--songs", type=int, default=3)
    args = ap.parse_args()

    import app
    from bench_align import songs

    picked = songs(Path(args.data), args.songs)
    if not picked:
        raise SystemExit("no sung song with audio in data/")  # a run over nothing is not a result
    print(f"ALIGN_METHOD={app.ALIGN_METHOD} ALIGN_QWEN_WEIGHT={getattr(app, 'ALIGN_QWEN_WEIGHT', None)}", flush=True)
    for sid, lyrics, dur, mp3 in picked:
        body = app.AlignRequest(lyrics=lyrics, audio_url=f"https://local/v1/audio/{sid}.mp3", duration_seconds=dur)
        res = app._align_path(body, mp3, sid)
        if hasattr(res, "status_code"):  # the 422 a refused alignment returns
            payload = json.loads(res.body)
            print(f"{sid[:8]} HTTP {res.status_code} {payload.get('error')} coverage={payload.get('coverage')} "
                  f"method={payload.get('method')}", flush=True)
            continue
        lines = res.get("lines", [])
        trusted = sum(1 for l in lines if l.get("confidence", 1) >= 0.5)
        print(f"{sid[:8]} method={res.get('method')} trusted={trusted}/{len(lines)} coverage={res.get('coverage')} "
              f"whisper={res.get('whisper_coverage')} offset={res.get('whisper_offset')} "
              f"partial={res.get('partial', False)} {res.get('seconds')}s", flush=True)
    print("qwen worker:", app._qwen_status())


if __name__ == "__main__":
    main()
