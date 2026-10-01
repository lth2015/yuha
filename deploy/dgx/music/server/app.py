"""
YUHA music generation service on DGX Spark (ACE-Step 3.5B).

Contract (see 部署需求 §4):
  POST /v1/jobs            -> {"id", "status", ...}  returns immediately
  GET  /v1/jobs/{id}       -> {"id", "status", "audio_url", ...}
  GET  /v1/audio/{id}.mp3?exp=..&sig=..   (signed, no auth header needed)
  GET  /healthz            (no auth)

Status words:  queued | running  -> pending
               succeeded         -> completed
               failed            -> failed   (retryable)
               rejected          -> rejected (not retryable)
"""
from __future__ import annotations

import hashlib
import hmac
import inspect
import json
import logging
import os
import queue
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import List, Literal, Optional

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, ConfigDict, Field, field_validator

# ---------------------------------------------------------------- config
API_KEY = os.environ.get("YUHA_API_KEY", "")
SIGNING_SECRET = os.environ.get("AUDIO_SIGNING_SECRET", API_KEY)
AUDIO_BASE_URL = os.environ.get("AUDIO_BASE_URL", "http://127.0.0.1:8000").rstrip("/")
AUDIO_URL_TTL = int(os.environ.get("AUDIO_URL_TTL_SECONDS", "86400"))
DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
CHECKPOINT_DIR = os.environ.get("ACE_CHECKPOINT_DIR", "/root/.cache/ace-step/checkpoints")
MAX_QUEUE = int(os.environ.get("MAX_QUEUE", "8"))
INFER_STEPS = int(os.environ.get("ACE_INFER_STEPS", "60"))
MP3_BITRATE = os.environ.get("MP3_BITRATE", "192k")
MIN_DUR, MAX_DUR = 10, 240
WHISPER_MODEL = os.environ.get("WHISPER_MODEL", "turbo")
ALIGN_MIN_COVERAGE = float(os.environ.get("ALIGN_MIN_COVERAGE", "0.15"))
# Vocal-quality knobs, chosen from bench_vocals.py results rather than by ear.
TAG_STYLE = os.environ.get("TAG_STYLE", "v1")            # v1 = original prompt, v2 = short tags + vocal descriptor
VOCAL_TAKES = max(1, int(os.environ.get("VOCAL_TAKES", "1")))  # >1: render N seeds, keep the most intelligible
LYRIC_GUIDANCE = float(os.environ.get("LYRIC_GUIDANCE", "0"))  # ACE-Step guidance_scale_lyric (0 = off)
# Engine: v1 = ACE-Step 3.5B in this process; v15 = the ACE-Step 1.5 REST server
# running beside us (compose service `acestep15`). Switch only after the bench.
ENGINE = os.environ.get("ENGINE", "v1")
V15_URL = os.environ.get("V15_URL", "http://acestep15:8001").rstrip("/")
V15_KEY = os.environ.get("V15_API_KEY", "")
V15_MODEL = os.environ.get("V15_MODEL", "")          # DiT slot name, e.g. acestep-v15-xl-sft; empty = server default
V15_STEPS = int(os.environ.get("V15_STEPS", "8"))     # turbo: 8, sft/base: ~50
V15_THINKING = os.environ.get("V15_THINKING", "true").lower() == "true"  # let the 5Hz LM plan the song

JOBS_DIR = DATA_DIR / "jobs"
AUDIO_DIR = DATA_DIR / "audio"
for d in (JOBS_DIR, AUDIO_DIR):
    d.mkdir(parents=True, exist_ok=True)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("yuha-music")

# ---------------------------------------------------------------- job store
_lock = threading.Lock()
_idem: dict[str, str] = {}
_q: "queue.Queue[str]" = queue.Queue()


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
    return json.loads(p.read_text())


def sign(job_id: str, exp: int) -> str:
    msg = f"{job_id}:{exp}".encode()
    return hmac.new(SIGNING_SECRET.encode(), msg, hashlib.sha256).hexdigest()


def audio_url(job_id: str) -> str:
    exp = int(time.time()) + AUDIO_URL_TTL
    return f"{AUDIO_BASE_URL}/v1/audio/{job_id}.mp3?exp={exp}&sig={sign(job_id, exp)}"


def public_view(job: dict) -> dict:
    out = {
        "id": job["id"],
        "status": job["status"],
        "audio_url": None,
        "error": job.get("error"),
        "duration_seconds": job["request"]["duration_seconds"],
        "created_at": job["created_at"],
        "queue_wait_seconds": job.get("queue_wait_seconds"),
        "generation_seconds": job.get("generation_seconds"),
        "audio_seconds": job.get("audio_seconds"),
    }
    if job["status"] == "succeeded":
        out["audio_url"] = audio_url(job["id"])
    return out


def recover_jobs() -> None:
    """On restart: re-queue anything that was queued/running."""
    items = []
    for p in JOBS_DIR.glob("*.json"):
        try:
            job = json.loads(p.read_text())
        except Exception:
            continue
        if job.get("idempotency_key"):
            _idem[job["idempotency_key"]] = job["id"]
        if job["status"] in ("queued", "running"):
            job["status"] = "queued"
            save_job(job)
            items.append(job)
    for job in sorted(items, key=lambda j: j["created_at"]):
        _q.put(job["id"])
    if items:
        log.info("recovered %d unfinished jobs", len(items))


# ---------------------------------------------------------------- model
_pipeline = None
_model_state = {"loaded": False, "error": None, "load_seconds": None}


def _patch_torchaudio_save():
    """torchaudio>=2.9 routes save() through torchcodec (not installed); write wav via soundfile."""
    import soundfile as sf
    import torchaudio

    def _save(uri, src, sample_rate, channels_first=True, format=None, **_):
        data = src.detach().float().cpu()
        if channels_first and data.ndim == 2:
            data = data.transpose(0, 1)
        sf.write(str(uri), data.numpy(), int(sample_rate), subtype="PCM_16", format="WAV")

    torchaudio.save = _save


def get_pipeline():
    global _pipeline
    if _pipeline is None:
        t0 = time.time()
        _patch_torchaudio_save()
        from acestep.pipeline_ace_step import ACEStepPipeline  # noqa

        _pipeline = ACEStepPipeline(
            checkpoint_dir=CHECKPOINT_DIR,
            dtype="bfloat16",
            torch_compile=False,
        )
        # Some versions load lazily on first call; force it if available.
        if hasattr(_pipeline, "load_checkpoint") and not getattr(_pipeline, "loaded", True):
            _pipeline.load_checkpoint(CHECKPOINT_DIR)
        _model_state["loaded"] = True
        _model_state["load_seconds"] = round(time.time() - t0, 1)
        log.info("ACE-Step pipeline ready in %.1fs", time.time() - t0)
    return _pipeline


# ---------------------------------------------------------------- lyric alignment
_whisper = None
_whisper_lock = threading.Lock()
_align_state = {"loaded": False, "error": None}


def get_whisper():
    global _whisper
    if _whisper is None:
        import whisper  # openai-whisper; plain PyTorch, so it runs on the NGC arm64 build
        t0 = time.time()
        _whisper = whisper.load_model(WHISPER_MODEL, device="cuda", download_root="/root/.cache/whisper")
        _align_state["loaded"] = True
        log.info("whisper %s ready in %.1fs", WHISPER_MODEL, time.time() - t0)
    return _whisper


def transcribe_words(path: Path, lyrics: str):
    from align import guess_language, parse_lyrics
    model = get_whisper()
    prompt = " ".join(t for _, t in parse_lyrics(lyrics))[:200]
    with _whisper_lock:
        res = model.transcribe(
            str(path),
            language=guess_language(lyrics),
            word_timestamps=True,
            initial_prompt=prompt or None,
            condition_on_previous_text=False,
            fp16=True,
        )
    words = []
    for seg in res.get("segments", []):
        for w in seg.get("words", []) or []:
            words.append((w["word"], float(w["start"]), float(w["end"])))
    return words


VOCALISE = (
    "[verse]\nooh ooh, la la la\nmm mm, la la la\n"
    "[chorus]\nla la la, ooh\nla la la, ooh ooh\n"
    "[verse]\nooh ooh, la la la\nmm mm, la la la\n"
    "[chorus]\nla la la, ooh\nla la la, ooh ooh\n"
)


def build_tags_v1(req: dict) -> str:
    """The original prompt: style + instruments + tempo/energy words + the whole English brief."""
    tags: List[str] = []
    tags += [t.replace("_", " ") for t in req.get("style_tags") or []]
    tags += [t.replace("_", " ") for t in req.get("instruments") or []]
    if req.get("tempo"):
        tags.append(f"{req['tempo']} tempo")
    e = req.get("energy")
    if e is not None:
        tags.append("low energy" if e < 0.35 else "high energy" if e > 0.7 else "medium energy")
    if req.get("instrumental"):
        tags.append("instrumental")
    tags.append(req["prompt"])
    return ", ".join(t for t in tags if t)


_VOICE_WORDS = [
    (r"\b(female|woman|girl|女声|女性ボーカル)\b", "female vocals"),
    (r"\b(male|man|boy|男声|男性ボーカル)\b", "male vocals"),
    (r"\b(choir|chorus vocals|合唱)\b", "choir"),
    (r"\b(duet|对唱|デュエット)\b", "duet"),
]
_FILLER = re.compile(r"^(a|an|the|with|and|of|in|for|some|very|little|bit)\s+", re.I)


def build_tags_v2(req: dict) -> str:
    """Short comma tags the model was trained on, plus an explicit voice.

    v1 handed ACE-Step a long English sentence, which dilutes the style tags
    and says nothing about who sings. Here the brief is cut into short phrases
    (at most four), and a vocal song always names a voice.
    """
    tags: List[str] = []
    tags += [t.replace("_", " ").strip() for t in req.get("style_tags") or []]
    tags += [t.replace("_", " ").strip() for t in req.get("instruments") or []]
    brief = (req.get("prompt") or "").strip()
    if req.get("instrumental"):
        tags.append("instrumental")
    else:
        voice = next((v for pat, v in _VOICE_WORDS if re.search(pat, brief, re.I)), None)
        tags += [voice or "lead vocals", "clear vocals"]
    tempo = req.get("tempo")
    if tempo:
        tags.append({"slow": "slow tempo", "medium": "mid-tempo", "fast": "fast tempo"}.get(tempo, f"{tempo} tempo"))
    e = req.get("energy")
    if e is not None:
        tags.append("mellow" if e < 0.35 else "energetic" if e > 0.7 else "")
    phrases = []
    for frag in re.split(r"[,.;:!?\n]+", brief):
        frag = _FILLER.sub("", frag.strip().lower())
        if frag and len(frag.split()) <= 6:
            phrases.append(frag)
    tags += phrases[:4]
    seen, out = set(), []
    for t in tags:
        k = t.lower()
        if t and k not in seen:
            seen.add(k)
            out.append(t)
    return ", ".join(out[:14])


def build_tags(req: dict, style: Optional[str] = None) -> str:
    return (build_tags_v2 if (style or TAG_STYLE) == "v2" else build_tags_v1)(req)


def lyrics_for(req: dict) -> str:
    # Never turn a vocal request into an instrumental behind the caller's back:
    # ACE-Step sings only what it is given, so with no lyrics a vocal song gets
    # a wordless vocal line instead of "[instrumental]".
    if req.get("instrumental"):
        return "[instrumental]"
    return req.get("lyrics") or VOCALISE


def render_v15(req: dict, out_dir: Path, *, seed: Optional[int] = None, tag_style: str = "v2",
               infer_steps: Optional[int] = None, model: Optional[str] = None, timeout_s: int = 900) -> Path:
    """Render through the ACE-Step 1.5 REST server (/release_task -> /query_result -> /v1/audio)."""
    import urllib.parse
    import urllib.request
    from align import guess_language

    def call(method: str, path: str, body: Optional[dict] = None, raw: bool = False):
        headers = {"content-type": "application/json"}
        if V15_KEY:
            headers["authorization"] = f"Bearer {V15_KEY}"
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(V15_URL + path, data=data, method=method, headers=headers)
        with urllib.request.urlopen(r, timeout=120) as resp:
            payload = resp.read()
        if raw:
            return payload
        j = json.loads(payload)
        return j.get("data", j) if isinstance(j, dict) else j

    out_dir.mkdir(parents=True, exist_ok=True)
    lyrics = lyrics_for(req)
    if lyrics == "[instrumental]":
        lyrics = "[Instrumental]"
    body = {
        "prompt": build_tags(req, tag_style),
        "lyrics": lyrics,
        "vocal_language": (guess_language(lyrics) if not req.get("instrumental") else None) or "en",
        "audio_duration": float(req["duration_seconds"]),
        "thinking": V15_THINKING,
        "inference_steps": infer_steps or V15_STEPS,
        "audio_format": "wav",
        "batch_size": 1,
        "use_random_seed": seed is None,
        "seed": seed if seed is not None else -1,
    }
    if model or V15_MODEL:
        body["model"] = model or V15_MODEL
    task = call("POST", "/release_task", body)
    task_id = task.get("task_id") if isinstance(task, dict) else None
    if not task_id:
        raise RuntimeError(f"acestep15 release_task gave no task_id: {str(task)[:300]}")
    t0 = time.time()
    while True:
        time.sleep(2)
        items = call("POST", "/query_result", {"task_id_list": [task_id]})
        item = items[0] if isinstance(items, list) and items else {}
        status = item.get("status")
        if status == 1:
            break
        if status == 2:
            raise RuntimeError(f"acestep15 task failed: {str(item.get('result'))[:300]}")
        if time.time() - t0 > timeout_s:
            raise RuntimeError("acestep15 task timed out")
    result = item.get("result")
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except json.JSONDecodeError:
            pass
    first = result[0] if isinstance(result, list) and result else result if isinstance(result, dict) else {}
    ref = first.get("file") or first.get("audio_path") or first.get("path") if isinstance(first, dict) else None
    if not ref:
        raise RuntimeError(f"acestep15 result has no file: {str(result)[:300]}")
    if ref.startswith("/v1/audio?path="):
        ref = urllib.parse.unquote(ref[len("/v1/audio?path="):])
    url = "/v1/audio?path=" + urllib.parse.quote(ref, safe="")
    wav_path = out_dir / f"take-{seed if seed is not None else 'r'}.wav"
    wav_path.write_bytes(call("GET", url, raw=True))
    return wav_path


def render(req: dict, out_dir: Path, *, seed: Optional[int] = None, tag_style: Optional[str] = None,
           lyric_guidance: Optional[float] = None, infer_steps: Optional[int] = None,
           engine: Optional[str] = None, v15_model: Optional[str] = None) -> Path:
    """One render to a wav in out_dir. Every knob defaults to the service setting."""
    if (engine or ENGINE) == "v15":
        return render_v15(req, out_dir, seed=seed, tag_style=tag_style or "v2", infer_steps=infer_steps, model=v15_model)
    pipe = get_pipeline()
    out_dir.mkdir(parents=True, exist_ok=True)
    wav_path = out_dir / f"take-{seed if seed is not None else 'r'}.wav"
    lg = LYRIC_GUIDANCE if lyric_guidance is None else lyric_guidance
    kwargs = dict(
        audio_duration=float(req["duration_seconds"]),
        prompt=build_tags(req, tag_style),
        lyrics=lyrics_for(req),
        infer_step=infer_steps or INFER_STEPS,
        guidance_scale=15.0,
        scheduler_type="euler",
        cfg_type="apg",
        omega_scale=10.0,
        manual_seeds=[seed] if seed is not None else None,
        guidance_interval=0.5,
        guidance_interval_decay=0.0,
        min_guidance_scale=3.0,
        use_erg_tag=True,
        use_erg_lyric=True,
        use_erg_diffusion=True,
        oss_steps=None,
        guidance_scale_text=0.0,
        guidance_scale_lyric=lg,
        save_path=str(wav_path),
        format="wav",
        batch_size=1,
    )
    # Tolerate signature drift between ACE-Step versions.
    sig = inspect.signature(pipe.__call__)
    if not any(p.kind == p.VAR_KEYWORD for p in sig.parameters.values()):
        kwargs = {k: v for k, v in kwargs.items() if k in sig.parameters}
    result = pipe(**kwargs)
    if wav_path.exists():
        return wav_path
    if isinstance(result, (list, tuple)):
        for r in result:
            if isinstance(r, str) and r.endswith(".wav") and Path(r).exists():
                return Path(r)
    cands = sorted(out_dir.glob("*.wav")) + sorted(Path(".").glob("outputs/*.wav"))
    if not cands:
        raise RuntimeError("ACE-Step returned no wav file")
    return cands[-1]


def intelligibility(path: Path, lyrics: str) -> float:
    """Share of the lyric characters Whisper heard, in order (0..1)."""
    from align import align_lines
    words = transcribe_words(path, lyrics)
    return float(align_lines(lyrics, words, 600.0)["coverage"])


def run_generation(job: dict) -> None:
    req = job["request"]
    work = DATA_DIR / "tmp" / job["id"]
    sung = not req.get("instrumental") and bool(req.get("lyrics"))
    takes = VOCAL_TAKES if sung else 1
    if takes == 1:
        produced = render(req, work)
    else:
        # Same request, different seeds: keep the take whose words come through.
        scored = []
        for i in range(takes):
            seed = int.from_bytes(os.urandom(4), "big") % 2_000_000_000
            wav = render(req, work, seed=seed)
            try:
                score = intelligibility(wav, req["lyrics"])
            except Exception:
                log.exception("take scoring failed")
                score = -1.0
            scored.append((score, seed, wav))
        scored.sort(key=lambda t: t[0], reverse=True)
        produced = scored[0][2]
        job["takes"] = [{"seed": sd, "intelligibility": round(sc, 3)} for sc, sd, _ in scored]
        job["intelligibility"] = round(scored[0][0], 3)

    mp3_path = AUDIO_DIR / f"{job['id']}.mp3"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(produced),
         "-codec:a", "libmp3lame", "-b:a", MP3_BITRATE, str(mp3_path)],
        check=True,
    )
    shutil.rmtree(work, ignore_errors=True)
    dur = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", str(mp3_path)],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    job["audio_seconds"] = round(float(dur), 2)
    job["audio_bytes"] = mp3_path.stat().st_size


def worker() -> None:
    try:
        if ENGINE == "v1":
            get_pipeline()
        else:
            _model_state["loaded"] = True  # the v15 server owns its own model
    except Exception as e:  # keep serving; jobs will fail with this error
        _model_state["error"] = repr(e)
        log.exception("model load failed")
    try:
        get_whisper()
    except Exception as e:  # alignment is optional; YUHA falls back to estimated timings
        _align_state["error"] = repr(e)
        log.exception("whisper load failed")
    while True:
        job_id = _q.get()
        job = load_job(job_id)
        if not job or job["status"] != "queued":
            continue
        job["status"] = "running"
        job["started_at"] = time.time()
        job["queue_wait_seconds"] = round(job["started_at"] - job["created_at"], 1)
        save_job(job)
        try:
            run_generation(job)
            job["status"] = "succeeded"
        except Exception as e:
            log.exception("job %s failed", job_id)
            job["status"] = "failed"
            job["error"] = repr(e)[:500]
        job["finished_at"] = time.time()
        job["generation_seconds"] = round(job["finished_at"] - job["started_at"], 1)
        save_job(job)
        log.info("job %s %s gen=%.1fs audio=%s", job_id, job["status"],
                 job["generation_seconds"], job.get("audio_seconds"))


# ---------------------------------------------------------------- API
app = FastAPI(title="YUHA music (ACE-Step)", redirect_slashes=False,
              docs_url=None, redoc_url=None, openapi_url=None)


class SubmitRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    model: Optional[str] = None
    duration_seconds: int = Field(..., ge=MIN_DUR, le=MAX_DUR)
    prompt: str = Field(..., min_length=1, max_length=1000)
    tempo: Optional[Literal["slow", "medium", "fast"]] = None
    energy: Optional[float] = Field(None, ge=0.0, le=1.0)
    instruments: Optional[List[str]] = None
    style_tags: Optional[List[str]] = None
    format: Literal["mp3"] = "mp3"
    instrumental: bool = False
    lyrics: Optional[str] = Field(None, max_length=6000)

    @field_validator("instruments", "style_tags")
    @classmethod
    def _short_list(cls, v):
        if v is not None and len(v) > 20:
            raise ValueError("too many items")
        return v


def check_auth(authorization: Optional[str]) -> None:
    if not API_KEY:
        raise HTTPException(500, "server misconfigured: YUHA_API_KEY empty")
    expected = f"Bearer {API_KEY}"
    if not authorization or not hmac.compare_digest(authorization.encode(), expected.encode()):
        raise HTTPException(401, "unauthorized")


@app.exception_handler(RequestValidationError)
async def _validation(_: Request, exc: RequestValidationError):
    return JSONResponse(status_code=422, content={"status": "rejected", "error": "invalid_request",
                                                  "detail": jsonable_errors(exc)})


def jsonable_errors(exc: RequestValidationError):
    return [{"loc": list(e.get("loc", [])), "msg": e.get("msg")} for e in exc.errors()]


@app.get("/healthz")
def healthz():
    return {"ok": True, "model_loaded": _model_state["loaded"],
            "model_error": _model_state["error"], "load_seconds": _model_state["load_seconds"],
            "queue_depth": _q.qsize(), "engine": ENGINE, "aligner_loaded": _align_state["loaded"],
            "aligner_error": _align_state["error"]}


@app.post("/v1/jobs")
def submit(body: SubmitRequest,
           authorization: Optional[str] = Header(None),
           idempotency_key: Optional[str] = Header(None)):
    check_auth(authorization)
    with _lock:
        if idempotency_key and idempotency_key in _idem:
            job = load_job(_idem[idempotency_key])
            if job:
                return JSONResponse(status_code=200, content=public_view(job))
        if _q.qsize() >= MAX_QUEUE:
            return JSONResponse(status_code=429, content={"error": "queue_full"},
                                headers={"Retry-After": "60"})
        req = body.model_dump()
        if req["instrumental"]:
            req["lyrics"] = None
        job = {
            "id": uuid.uuid4().hex,
            "status": "queued",
            "created_at": time.time(),
            "request": req,
            "idempotency_key": idempotency_key,
        }
        save_job(job)
        if idempotency_key:
            _idem[idempotency_key] = job["id"]
        _q.put(job["id"])
    return JSONResponse(status_code=200, content=public_view(job))


@app.get("/v1/jobs/{job_id}")
def poll(job_id: str, authorization: Optional[str] = Header(None)):
    check_auth(authorization)
    # YUHA polls by its own request key (= Idempotency-Key) when it never saw our id
    # (e.g. the submit timed out). Resolve that too; anything unknown is a plain 404.
    job = load_job(job_id) if job_id.isalnum() else None
    if not job and job_id in _idem:
        job = load_job(_idem[job_id])
    if not job:
        raise HTTPException(404, "not found")
    return public_view(job)


class AlignRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")
    lyrics: str = Field(..., min_length=1, max_length=6000)
    audio_url: str = Field(..., min_length=1, max_length=2000)
    duration_seconds: float = Field(..., gt=0, le=600)


@app.post("/v1/align")
def align(body: AlignRequest, authorization: Optional[str] = Header(None)):
    """YUHA's alignment contract: {lyrics, audio_url, duration_seconds} -> lines[]."""
    check_auth(authorization)
    import re
    from align import align_lines
    m = re.search(r"([0-9a-f]{32})(?:\.mp3)?(?:\?|$)", body.audio_url)
    if not m:
        raise HTTPException(422, "audio_url does not name a job on this server")
    path = AUDIO_DIR / f"{m.group(1)}.mp3"
    if not path.exists():
        raise HTTPException(404, "audio not found")
    t0 = time.time()
    try:
        words = transcribe_words(path, body.lyrics)
    except Exception as e:
        log.exception("alignment failed")
        raise HTTPException(500, f"alignment failed: {e!r}"[:300])
    out = align_lines(body.lyrics, words, body.duration_seconds)
    out["seconds"] = round(time.time() - t0, 1)
    out["model"] = f"whisper-{WHISPER_MODEL}"
    log.info("aligned %s coverage=%.2f in %.1fs", m.group(1), out["coverage"], out["seconds"])
    if out["coverage"] < ALIGN_MIN_COVERAGE:
        # Too little of the lyrics was heard to trust the timings; YUHA keeps
        # its estimated (and labelled) timeline instead.
        return JSONResponse(status_code=422, content={"error": "low_coverage", **out})
    return out


@app.get("/v1/audio/{name}")
def audio(name: str, exp: int, sig: str):
    if not name.endswith(".mp3"):
        raise HTTPException(404)
    job_id = name[:-4]
    if not job_id.isalnum():
        raise HTTPException(404)
    if exp < time.time() or not hmac.compare_digest(sig, sign(job_id, exp)):
        raise HTTPException(403, "expired or bad signature")
    path = AUDIO_DIR / name
    if not path.exists():
        raise HTTPException(404)
    return FileResponse(path, media_type="audio/mpeg")


@app.on_event("startup")
def _startup():
    recover_jobs()
    threading.Thread(target=worker, daemon=True, name="gen-worker").start()
