"""
YUHA video clip service on dgxv (docs/AI_SCENE_MV_TICKETS.md, T1).

One job is one short, silent shot. YUHA asks for the shots of a scene MV one
at a time and cuts them to the song itself; nothing here knows about songs,
lyrics or users.

  POST /v1/clips                  -> {"id", "status", ...}   returns at once
  GET  /v1/clips/{id}             -> {"id", "status", "clip_url", ...}
  POST /v1/clips/{id}/cancel      -> the job, cancelled or cancelling
  GET  /v1/files/{id}.mp4?exp=&sig=   signed, no auth header
  GET  /healthz                   no auth

Status words: queued | running | succeeded | failed | cancelled.

Rules this file keeps, each from docs/AI_SCENE_MV_SPEC.md:
  - one clip on the GPU at a time (a single worker under `_gpu_lock`);
  - a bounded queue: past MAX_QUEUE the answer is 429 queue_full, never an
    unbounded wait somebody has paid for;
  - a cancel of a queued clip is immediate; a running one stops between
    denoising steps, without killing the shared model;
  - no audio leaves: every clip is checked with ffprobe and refused if it has
    an audio stream;
  - the prompt is never logged, and is removed from the job record as soon as
    the job is over; clips and records go after RETENTION_HOURS.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import queue
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from backends import Cancelled, ClipRequest, frames_for, make_backend

# ---------------------------------------------------------------- config
API_KEY = os.environ.get("YUHA_API_KEY", "")
SIGNING_SECRET = os.environ.get("CLIP_SIGNING_SECRET", API_KEY)
CLIP_BASE_URL = os.environ.get("CLIP_BASE_URL", "http://127.0.0.1:8100").rstrip("/")
CLIP_URL_TTL = int(os.environ.get("CLIP_URL_TTL_SECONDS", "3600"))
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
MAX_QUEUE = int(os.environ.get("MAX_QUEUE", "8"))
MAX_SECONDS = float(os.environ.get("MAX_CLIP_SECONDS", "10"))
MAX_EDGE = int(os.environ.get("MAX_EDGE", "1280"))
DEFAULT_STEPS = int(os.environ.get("VIDEO_STEPS", "40"))
# A restarted clip starts over; one that has been cut off this many times is failed instead.
MAX_ATTEMPTS = 2
# YUHA copies a finished clip within minutes and the signed URL lives an hour;
# two days covers a weekend of nobody looking. 0 keeps everything (bench only).
RETENTION_HOURS = float(os.environ.get("RETENTION_HOURS", "48"))

JOBS_DIR = DATA_DIR / "jobs"
CLIPS_DIR = DATA_DIR / "clips"
for d in (JOBS_DIR, CLIPS_DIR):
    d.mkdir(parents=True, exist_ok=True)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("yuha-video")

OPEN = ("queued", "running")

# ---------------------------------------------------------------- job store
_lock = threading.Lock()
_gpu_lock = threading.RLock()
_idem: dict[str, str] = {}
_q: "queue.Queue[str]" = queue.Queue()
backend = make_backend()


def _job_path(job_id: str) -> Path:
    return JOBS_DIR / f"{job_id}.json"


def save_job(job: dict) -> None:
    tmp = _job_path(job["id"]).with_suffix(".tmp")
    tmp.write_text(json.dumps(job, ensure_ascii=False))
    tmp.replace(_job_path(job["id"]))


def load_job(job_id: str) -> Optional[dict]:
    p = _job_path(job_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def _all_jobs() -> list[dict]:
    out = []
    for p in JOBS_DIR.glob("*.json"):
        try:
            out.append(json.loads(p.read_text()))
        except Exception:
            continue
    return out


def _finish(job: dict, status: str, error: Optional[str] = None) -> None:
    """Over: the words that described the shot are not kept past this point."""
    job["status"] = status
    job["error"] = error
    job["finished_at"] = time.time()
    job["request"].pop("prompt", None)
    job["request"].pop("negative_prompt", None)
    save_job(job)


def sign(job_id: str, exp: int) -> str:
    return hmac.new(SIGNING_SECRET.encode(), f"{job_id}:{exp}".encode(), hashlib.sha256).hexdigest()


def clip_url(job_id: str) -> str:
    exp = int(time.time()) + CLIP_URL_TTL
    return f"{CLIP_BASE_URL}/v1/files/{job_id}.mp4?exp={exp}&sig={sign(job_id, exp)}"


def queue_position(job: dict) -> Optional[int]:
    """Clips ahead of this one, the running one included; None once it is not waiting."""
    if job["status"] != "queued":
        return None
    ahead = [j for j in _all_jobs() if j["status"] in OPEN and j["id"] != job["id"]
             and (j["status"] == "running" or (j["created_at"], j["id"]) < (job["created_at"], job["id"]))]
    return len(ahead)


def public_view(job: dict) -> dict:
    r = job["request"]
    return {
        "id": job["id"],
        "status": job["status"],
        "clip_url": clip_url(job["id"]) if job["status"] == "succeeded" else None,
        "error": job.get("error"),
        "cancel_requested": bool(job.get("cancel_requested")),
        "queue_position": queue_position(job),
        "width": r["width"],
        "height": r["height"],
        "frames": r["frames"],
        "fps": r["fps"],
        "steps": r["steps"],
        "seed": r.get("seed"),
        "created_at": job["created_at"],
        "queue_wait_seconds": job.get("queue_wait_seconds"),
        "generation_seconds": job.get("generation_seconds"),
        "total_seconds": job.get("total_seconds"),
        "clip_seconds": job.get("clip_seconds"),
        "peak_memory_gb": job.get("peak_memory_gb"),
        "model": job.get("model"),
        "attempts": job.get("attempts", 0),
    }


# ---------------------------------------------------------------- checks on the output
def probe(path: Path) -> dict:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    )
    info = json.loads(out.stdout)
    kinds = [s.get("codec_type") for s in info.get("streams", [])]
    return {"video": kinds.count("video"), "audio": kinds.count("audio"),
            "seconds": float(info.get("format", {}).get("duration") or 0)}


# ---------------------------------------------------------------- worker
def _should_stop(job_id: str):
    def check() -> bool:
        j = load_job(job_id)
        return not j or bool(j.get("cancel_requested"))
    return check


def run_one(job_id: str) -> None:
    with _lock:
        job = load_job(job_id)
        if not job or job["status"] != "queued":
            return
        job["status"] = "running"
        job["attempts"] = job.get("attempts", 0) + 1
        job["started_at"] = time.time()
        job["queue_wait_seconds"] = round(job["started_at"] - job["created_at"], 2)
        save_job(job)
    r = job["request"]
    out = CLIPS_DIR / f"{job_id}.mp4"
    req = ClipRequest(prompt=r["prompt"], negative_prompt=r.get("negative_prompt") or "", width=r["width"],
                      height=r["height"], frames=r["frames"], fps=r["fps"], steps=r["steps"], seed=r.get("seed"))
    status, error, result = "failed", None, None
    try:
        with _gpu_lock:
            result = backend.render(req, out, _should_stop(job_id))
        p = probe(out)
        if p["audio"]:
            raise RuntimeError("clip_has_audio")
        if not p["video"]:
            raise RuntimeError("clip_has_no_video")
        job["clip_seconds"] = round(p["seconds"], 3)
        status = "succeeded"
    except Cancelled:
        status = "cancelled"
    except Exception as e:  # noqa: BLE001 — the reason is reported, the prompt is not
        name = type(e).__name__
        oom = "out of memory" in str(e).lower() or name == "OutOfMemoryError"
        # Fixed codes only: a backend's message can quote its input, and the input is the prompt.
        known = str(e) if isinstance(e, RuntimeError) and str(e) in ("clip_has_audio", "clip_has_no_video") else None
        error = "out_of_memory" if oom else (known or name)
        log.warning("clip %s failed: %s", job_id, error)
    if status != "succeeded":
        out.unlink(missing_ok=True)
    with _lock:
        latest = load_job(job_id) or job
        if status == "succeeded" and latest.get("cancel_requested"):
            # Finished in the same moment it was cancelled: the cancel wins, nobody waits on it.
            out.unlink(missing_ok=True)
            status = "cancelled"
        latest.update({k: job[k] for k in ("attempts", "started_at", "queue_wait_seconds") if k in job})
        if "clip_seconds" in job:
            latest["clip_seconds"] = job["clip_seconds"]
        if result:
            latest["generation_seconds"] = result.seconds_generating
            latest["peak_memory_gb"] = result.peak_memory_gb
            latest["model"] = result.model
        latest["total_seconds"] = round(time.time() - latest["started_at"], 2)
        _finish(latest, status, error)
    log.info("clip %s %s gen=%ss total=%ss", job_id, status, latest.get("generation_seconds"), latest["total_seconds"])


def worker() -> None:
    try:
        with _gpu_lock:
            backend.load()
        backend.loaded = True
    except Exception as e:  # keep answering; clips fail with this reason
        backend.error = repr(e)[:300]
        log.exception("model load failed")
    while True:
        job_id = _q.get()
        if backend.error:
            with _lock:
                job = load_job(job_id)
                if job and job["status"] == "queued":
                    _finish(job, "failed", "model_not_loaded")
            continue
        try:
            run_one(job_id)
        except Exception as e:  # the queue keeps moving; this clip is failed, not left running
            log.error("clip %s: internal error %s", job_id, type(e).__name__)
            try:
                with _lock:
                    job = load_job(job_id)
                    if job and job["status"] in OPEN:
                        _finish(job, "failed", "internal")
            except Exception:
                log.exception("could not mark clip %s failed", job_id)


def recover_jobs() -> None:
    """On restart: queued clips wait again; a running one starts over, up to MAX_ATTEMPTS."""
    items = []
    for job in _all_jobs():
        if job.get("idempotency_key"):
            _idem[job["idempotency_key"]] = job["id"]
        if job["status"] not in OPEN:
            continue
        if job.get("cancel_requested"):
            _finish(job, "cancelled")
        elif job["status"] == "running" and job.get("attempts", 0) >= MAX_ATTEMPTS:
            _finish(job, "failed", "interrupted")
        else:
            job["status"] = "queued"
            save_job(job)
            items.append(job)
    for job in sorted(items, key=lambda j: (j["created_at"], j["id"])):
        _q.put(job["id"])
    if items:
        log.info("recovered %d unfinished clips", len(items))


def purge_old(now: Optional[float] = None) -> int:
    """Finished jobs and their clips older than RETENTION_HOURS; open ones are never touched."""
    if RETENTION_HOURS <= 0:
        return 0
    cutoff = (now if now is not None else time.time()) - RETENTION_HOURS * 3600
    removed = 0
    for job in _all_jobs():
        if job["status"] in OPEN or float(job.get("created_at", cutoff)) >= cutoff:
            continue
        with _lock:
            if job.get("idempotency_key"):
                _idem.pop(job["idempotency_key"], None)
            (CLIPS_DIR / f"{job['id']}.mp4").unlink(missing_ok=True)
            _job_path(job["id"]).unlink(missing_ok=True)
        removed += 1
    for f in CLIPS_DIR.iterdir():
        try:
            if f.is_file() and f.stat().st_mtime < cutoff:
                f.unlink()
        except FileNotFoundError:
            pass
    return removed


def _retention_loop() -> None:
    while True:
        try:
            n = purge_old()
            if n:
                log.info("retention: removed %d clips older than %g hours", n, RETENTION_HOURS)
        except Exception:
            log.exception("retention sweep failed")
        time.sleep(3600)


# ---------------------------------------------------------------- API
app = FastAPI(title="YUHA video clips", redirect_slashes=False, docs_url=None, redoc_url=None, openapi_url=None)


class ClipBody(BaseModel):
    model_config = ConfigDict(extra="forbid")
    prompt: str = Field(min_length=1, max_length=1500)
    negative_prompt: str = Field(default="", max_length=800)
    width: int = Field(ge=64)
    height: int = Field(ge=64)
    seconds: float = Field(gt=0)
    fps: int = Field(default=24, ge=8, le=30)
    steps: Optional[int] = Field(default=None, ge=1, le=100)
    seed: Optional[int] = Field(default=None, ge=0, le=2**32 - 1)


def check_auth(authorization: Optional[str]) -> None:
    if not API_KEY:
        raise HTTPException(500, "server misconfigured: YUHA_API_KEY empty")
    expected = f"Bearer {API_KEY}"
    if not authorization or not hmac.compare_digest(authorization.encode(), expected.encode()):
        raise HTTPException(401, "unauthorized")


def reject(code: int, error: str, detail: str = "") -> JSONResponse:
    return JSONResponse(status_code=code, content={"status": "rejected", "error": error, "detail": detail})


@app.exception_handler(RequestValidationError)
async def _validation(_: Request, exc: RequestValidationError):
    # Field names and limits only: the input itself (a prompt) is not echoed back.
    detail = [{"loc": e.get("loc"), "msg": e.get("msg")} for e in exc.errors()]
    return JSONResponse(status_code=422, content={"status": "rejected", "error": "invalid_request", "detail": detail})


@app.get("/healthz")
def healthz():
    jobs = _all_jobs()
    return {
        "ok": True,
        "backend": backend.name,
        "model_loaded": bool(backend.loaded),
        "model_error": backend.error,
        "queued": sum(j["status"] == "queued" for j in jobs),
        "running": sum(j["status"] == "running" for j in jobs),
        "max_queue": MAX_QUEUE,
    }


@app.post("/v1/clips", status_code=202)
def submit(body: ClipBody, authorization: Optional[str] = Header(None),
           idempotency_key: Optional[str] = Header(None)):
    check_auth(authorization)
    m = backend.size_multiple
    if body.width % m or body.height % m:
        return reject(422, "invalid_size", f"width and height must be multiples of {m}")
    if max(body.width, body.height) > MAX_EDGE:
        return reject(422, "invalid_size", f"longest edge is at most {MAX_EDGE}")
    if body.seconds > MAX_SECONDS:
        return reject(422, "too_long", f"at most {MAX_SECONDS:g} seconds per clip")
    with _lock:
        digest = hashlib.sha256(body.model_dump_json().encode()).hexdigest()
        if idempotency_key and idempotency_key in _idem:
            prior = load_job(_idem[idempotency_key])
            if prior:
                if prior.get("request_sha") != digest:
                    return reject(409, "idempotency_key_reused", "this key was used for a different clip; a retry needs a new key")
                return JSONResponse(status_code=200, content=public_view(prior))
        open_now = sum(j["status"] in OPEN for j in _all_jobs())
        if open_now >= MAX_QUEUE:
            return reject(429, "queue_full", f"{open_now} clips waiting; try again later")
        job = {
            "id": uuid.uuid4().hex,
            "status": "queued",
            "created_at": time.time(),
            "idempotency_key": idempotency_key,
            "request_sha": digest,
            "attempts": 0,
            "request": {
                "prompt": body.prompt,
                "negative_prompt": body.negative_prompt,
                "width": body.width,
                "height": body.height,
                "fps": body.fps,
                "frames": frames_for(body.seconds, body.fps, backend.frame_multiple),
                "steps": body.steps or DEFAULT_STEPS,
                "seed": body.seed,
            },
        }
        save_job(job)
        if idempotency_key:
            _idem[idempotency_key] = job["id"]
    _q.put(job["id"])
    return public_view(job)


def _job_or_404(job_id: str) -> dict:
    if not job_id.isalnum():
        raise HTTPException(404, "not found")
    job = load_job(job_id)
    if not job:
        raise HTTPException(404, "not found")
    return job


@app.get("/v1/clips/{job_id}")
def poll(job_id: str, authorization: Optional[str] = Header(None)):
    check_auth(authorization)
    return public_view(_job_or_404(job_id))


@app.post("/v1/clips/{job_id}/cancel")
def cancel(job_id: str, authorization: Optional[str] = Header(None)):
    check_auth(authorization)
    with _lock:
        job = _job_or_404(job_id)
        if job["status"] == "queued":
            job["cancel_requested"] = True
            _finish(job, "cancelled")
        elif job["status"] == "running":
            job["cancel_requested"] = True
            save_job(job)
    return public_view(job)


@app.get("/v1/files/{name}")
def file(name: str, exp: int, sig: str):
    job_id = name.removesuffix(".mp4")
    if not name.endswith(".mp4") or not job_id.isalnum():
        raise HTTPException(404, "not found")
    if exp < time.time() or not hmac.compare_digest(sig.encode(), sign(job_id, exp).encode()):
        raise HTTPException(403, "expired or invalid signature")
    path = CLIPS_DIR / name
    if not path.exists():
        raise HTTPException(404, "not found")
    return FileResponse(path, media_type="video/mp4")


@app.on_event("startup")
def _startup():
    recover_jobs()
    threading.Thread(target=worker, daemon=True, name="clip-worker").start()
    threading.Thread(target=_retention_loop, daemon=True, name="retention").start()
