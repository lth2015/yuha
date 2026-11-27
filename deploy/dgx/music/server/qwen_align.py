"""
Qwen3-ForcedAligner-0.6B (weights and code Apache-2.0), for ALIGN_METHOD=qwen.

The aligner needs transformers 4.57, ACE-Step in this image pins 4.50, so it
lives in its own venv (/opt/qwenv, see the Dockerfile) and runs as one
long-lived worker process (qwen_worker.py): the model loads once, each request
is a line of JSON in and a line out. This client starts it on first use,
starts it again if it died, and gives up on one that does not answer.
Anything that goes wrong raises; the caller falls back to Whisper.
"""
from __future__ import annotations

import json
import logging
import os
import selectors
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path
from typing import List, Optional, Tuple

import numpy as np

log = logging.getLogger("yuha-music")

LANGUAGES = {"zh": "Chinese", "ja": "Japanese", "en": "English"}
_lock = threading.Lock()
_proc: Optional[subprocess.Popen] = None
_state = {"error": None, "started_at": None}


def _python() -> str:
    return os.environ.get("QWEN_PYTHON", "/opt/qwenv/bin/python")


def _worker() -> str:
    return os.environ.get("QWEN_WORKER", str(Path(__file__).with_name("qwen_worker.py")))


def _timeout() -> float:
    # The first request loads the model (and downloads it once): generous.
    return float(os.environ.get("QWEN_TIMEOUT", "300"))


def status() -> dict:
    alive = _proc is not None and _proc.poll() is None
    return {"installed": Path(_python()).exists(), "pid": _proc.pid if alive else None, **_state}


def stop() -> None:
    global _proc
    if _proc is not None:
        try:
            _proc.kill()
            _proc.wait(timeout=5)
        except Exception:
            pass
    _proc = None


def _start() -> subprocess.Popen:
    global _proc
    if not Path(_python()).exists():
        raise RuntimeError(f"qwen aligner not installed ({_python()} missing)")
    _proc = subprocess.Popen([_python(), _worker()], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                             stderr=None, text=True, bufsize=1)
    _state["started_at"] = time.time()
    return _proc


def align(stem16: np.ndarray, lyrics: str, language: Optional[str]) -> List[Tuple[str, float, float]]:
    """Timed units (characters or words) for the lyrics on a 16 kHz mono vocal stem."""
    from align import parse_lyrics
    text = " ".join(line for _, line in parse_lyrics(lyrics))
    with _lock:
        proc = _proc if _proc is not None and _proc.poll() is None else _start()
        fd, npy = tempfile.mkstemp(suffix=".npy")
        os.close(fd)
        try:
            np.save(npy, np.asarray(stem16, dtype=np.float32))
            rid = uuid.uuid4().hex
            try:
                proc.stdin.write(json.dumps({"id": rid, "npy": npy, "text": text,
                                             "language": LANGUAGES.get(language or "zh", "Chinese")}) + "\n")
                proc.stdin.flush()
            except (BrokenPipeError, OSError) as e:
                stop()
                raise RuntimeError(f"qwen worker gone: {e!r}")
            sel = selectors.DefaultSelector()
            sel.register(proc.stdout, selectors.EVENT_READ)
            deadline = time.time() + _timeout()
            while True:
                left = deadline - time.time()
                if left <= 0 or not sel.select(timeout=left):
                    stop()
                    _state["error"] = "timed out"
                    raise RuntimeError("qwen worker timed out")
                line = proc.stdout.readline()
                if not line:
                    code = proc.poll()
                    stop()
                    _state["error"] = f"exited {code}"
                    raise RuntimeError(f"qwen worker exited ({code})")
                try:
                    msg = json.loads(line)
                except ValueError:
                    continue  # not ours: a library wrote to stdout
                if msg.get("id") != rid:
                    continue
                if msg.get("error"):
                    _state["error"] = msg["error"]
                    raise RuntimeError(msg["error"])
                _state["error"] = None
                return [(str(u[0]), float(u[1]), float(u[2])) for u in msg.get("units", [])]
        finally:
            Path(npy).unlink(missing_ok=True)
