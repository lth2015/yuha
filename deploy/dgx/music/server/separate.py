"""
The vocal on its own, for the aligner.

Whisper was transcribing the full mix, and on a song it is two different
instruments: where the accompaniment is loud its word clock drifts, and across
an instrumental it has nothing to hold on to, so the first word after one is
stretched back into it (the line lights up while the band is still playing)
and the last word before one is stretched forward (the line stays lit through
it). Demucs (htdemucs) takes the vocal out first; Whisper then hears a singer,
and the stem's own loudness says where singing is and is not.

Everything here is optional at runtime. If demucs is missing or its weights
cannot be fetched, `vocal_stem` returns None and alignment runs on the mix
exactly as before — slower to be right, never down.
"""
from __future__ import annotations

import logging
import math
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import List, Optional

import numpy as np

log = logging.getLogger("yuha-music")

SEPARATE = os.environ.get("ALIGN_SEPARATE", "on").lower() != "off"
DEMUCS_MODEL = os.environ.get("DEMUCS_MODEL", "htdemucs")

_model = None
_model_lock = threading.Lock()
_state = {"available": None, "error": None, "retry_at": 0.0}


def decode(path: Path, sr: int, channels: int) -> np.ndarray:
    """[channels, samples] float32 at `sr`, decoded by ffmpeg (already in the image)."""
    raw = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", str(path), "-f", "f32le",
         "-ac", str(channels), "-ar", str(sr), "-"],
        check=True, capture_output=True,
    ).stdout
    return np.frombuffer(raw, dtype=np.float32).reshape(-1, channels).T.copy()


def _load():
    global _model
    with _model_lock:
        # A failed load is retried after a while rather than never: the first
        # use downloads weights, and one network blip should not leave every
        # later song aligned on the mix until somebody restarts the container.
        if _model is None and time.time() >= _state["retry_at"]:
            try:
                import torch
                from demucs.pretrained import get_model
                m = get_model(DEMUCS_MODEL)
                m.to("cuda" if torch.cuda.is_available() else "cpu").eval()
                _model = m
                _state["available"] = True
                log.info("demucs %s ready for alignment", DEMUCS_MODEL)
            except Exception as e:  # missing package, no network for weights, ...
                _state["available"] = False
                _state["error"] = repr(e)[:300]
                _state["retry_at"] = time.time() + 600
                log.warning("vocal separation unavailable, aligning on the mix: %r", e)
    return _model


def vocal_stem(path: Path) -> Optional[tuple]:
    """(mono vocal float32, sample rate), or None to align on the mix.

    Caller holds the GPU lock.
    """
    if not SEPARATE:
        return None
    model = _load()
    if model is None:
        return None
    import torch
    from demucs.apply import apply_model

    sr = int(model.samplerate)
    wav = torch.from_numpy(decode(path, sr, int(model.audio_channels)))
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    with torch.no_grad():
        sources = apply_model(model, ((wav - mean) / std)[None], device=next(model.parameters()).device,
                              split=True, overlap=0.25, progress=False)[0]
    vocals = (sources[model.sources.index("vocals")] * std + mean).mean(0)
    return vocals.float().cpu().numpy(), sr


def to_16k(mono: np.ndarray, sr: int) -> np.ndarray:
    """Whisper takes 16 kHz mono float32 arrays directly."""
    if sr == 16000:
        return mono.astype(np.float32)
    import torch
    import julius  # a demucs dependency, so present whenever a stem exists
    return julius.resample_frac(torch.from_numpy(mono), sr, 16000).numpy().astype(np.float32)


def loudness_envelope(mono: np.ndarray, sr: int, hop: float = 0.02) -> List[float]:
    """dBFS of each `hop` seconds of the stem — the input to align.voiced_intervals."""
    n = max(1, int(round(sr * hop)))
    frames = len(mono) // n
    if frames == 0:
        return []
    rms = np.sqrt(np.mean(mono[: frames * n].reshape(frames, n) ** 2, axis=1))
    return [20 * math.log10(max(float(r), 1e-9)) for r in rms]


def status() -> dict:
    return {"enabled": SEPARATE, "model": DEMUCS_MODEL, **_state}
