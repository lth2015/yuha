# YUHA video clip service (dgxv)

Ticket T1 in `docs/AI_SCENE_MV_TICKETS.md`. It makes one short, **silent** shot per job.
YUHA will ask for a scene MV's shots one at a time and cut them to the song itself.
Nothing here knows about songs, lyrics or users. **YUHA does not call it yet.**

## Status: what is verified and what is not

| Claim | State |
| --- | --- |
| Queue, cancel, restart recovery, retention, the silence check, signed links, prompt not logged or kept | Unit-tested on the fake backend (`server/test_app.py`, 15 tests; eight planted defects each caught) |
| `bench.py` end to end | Run against the fake backend on Linux; the table it writes is real for that run |
| The image builds on dgxv (arm64, NGC 25.09) | **Not run.** I cannot reach dgxv. |
| `LTXPipeline` + `Lightricks/LTX-Video` loads and renders on DGX Spark | **Not run.** This is a baseline for the bench, not the chosen model. |
| LTX-2.5, the spec's candidate: whether it exists in diffusers, its exact version, its licence | **Unverified**; ticket T2. Set `VIDEO_MODEL` / `VIDEO_PIPELINE` once T2 says what it is. |
| Any time, memory or cost figure | **None yet.** The numbers come from the bench, on dgxv. |

## Deploy (from the Mac that can `ssh dgxv`)

```bash
cd deploy/dgx/video && ./deploy.sh
```

This copies this directory to `~/yuha-video` and, on the first run only, writes `.env` with a new key
that stays on the box. It then builds and starts `yuha-video` on port 8100 and waits for the model to
load. The first start downloads the weights into `~/.cache/huggingface`.

To finish, it checks that a well-formed submit with no key is refused with 401. A 200 or a 422 there
means something else is answering.

The port is bound to 127.0.0.1 only (`BIND_ADDR` in `.env` changes that). Reach it from outside
through a TLS proxy on 443, never directly: Docker's published ports bypass ufw.

The script refuses `DGX=dgxa`, the music box, unless you also set `SHARED=1`. The spec puts video on its
own machine, and on a single DGX Spark both models would share one pool of memory.

## Bench (on dgxv)

```bash
ssh dgxv 'cd ~/yuha-video && python3 bench.py'                       # cold start + 5 warm runs × 4 configs
ssh dgxv 'cd ~/yuha-video && python3 bench.py --runs 30 --only v4'   # the chosen config, 30 runs
```

The four configs are vertical and horizontal frames (480×832 and 832×480) at 4 s and 8 s, all at 24 fps.

A cold start restarts the container and times how long the model takes to load. The first clip after
that is recorded apart from the warm runs.

Every run records:
- queue wait, GPU time and end-to-end time;
- clip length;
- peak torch allocation;
- peak host memory in use, sampled from `/proc/meminfo` (Spark's memory is unified, so this number shows
  whether music can run beside it);
- each failure and its reason (`out_of_memory`, `bench_timeout`, …).

The bench writes `bench-<stamp>.jsonl` and `bench-<stamp>.md`. Paste the `.md` table into §8 of the spec.
**Watch the clips in `data/clips/` before trusting any number.** A fast run that draws mush is not a
result.

The prompts are fixed bench scenes. They contain no user's words, photos or songs.

## API

All endpoints except `/healthz` and `/v1/files` need `Authorization: Bearer $YUHA_API_KEY`.

| | |
| --- | --- |
| `POST /v1/clips` | `{prompt, negative_prompt?, width, height, seconds, fps?, steps?, seed?}` → 202 and the job. Width and height must be multiples of 32, with the longest edge ≤ `MAX_EDGE`. `seconds` ≤ `MAX_CLIP_SECONDS`. Frames are rounded up to 8k+1. An `Idempotency-Key` header returns the same job on a repeat. A full queue returns **429 `queue_full`**. |
| `GET /v1/clips/{id}` | status (`queued` / `running` / `succeeded` / `failed` / `cancelled`), `queue_position`, timings, `peak_memory_gb`, `model`, and `clip_url` (signed, valid for one hour) once it has succeeded |
| `POST /v1/clips/{id}/cancel` | Cancels a queued clip at once. A running clip stops at the next denoising step; the shared model is never killed. A clip that finishes in the same moment it is cancelled is discarded. |
| `GET /v1/files/{id}.mp4?exp&sig` | the clip |
| `GET /healthz` | backend, `model_loaded`, `model_error`, queue depth |

The service also enforces these rules:
- Only one clip is on the GPU at a time.
- A clip cut off by a restart starts over. After two attempts it is marked `interrupted`.
- Every clip is checked with ffprobe and refused (`clip_has_audio`) if it has an audio stream.
- Prompts are never logged. They are deleted from the job record when the job ends. A failure is recorded as a fixed code
  (`out_of_memory`, `internal`, the exception's class name), never as the backend's message, which could quote the prompt.
- Reusing an `Idempotency-Key` for a different clip returns 409 `idempotency_key_reused`, so a retry needs a new key.
- Jobs and clips are deleted after `RETENTION_HOURS` (default 48). A clip that is queued or running is
  never deleted.

## Tests

```bash
cd server && python3 -m unittest test_app -v     # needs fastapi, httpx, ffmpeg; no GPU
```
