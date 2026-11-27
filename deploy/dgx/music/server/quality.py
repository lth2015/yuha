"""
What the render report says about a take (docs/BGM_STUDIO_PLAN.md, B2).

Measured on the raw render, before mastering. The delivered MP3 cannot tell:
`_master` normalises every song to a -2.5 dBTP ceiling, so its peak reads
about -2.5 dB whether the render was clean or squared off, and the
`maxVolumeDb` YUHA probes on delivery says nothing about clipping.

  clipping        runs of samples held at full scale. A single sample at the
                  peak is a peak; a float render that goes past 1.0 keeps its
                  waveform and mastering lowers it intact; flat tops below
                  full scale are a limiter, not damage.
  vocal_presence  for an instrumental take: how much of it the vocal stem
                  carries, and for how long it carries a voice. Separation
                  always leaks a little; a voice is counted only where the
                  stem is both audible and a real share of the window.

Neither decides anything here. They are reported; YUHA records them, and the
thresholds are set from listening (the 30-take review), not from these
defaults alone.
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np

FULL_SCALE = 0.999  # at or above this, a sample is at full scale (int and float renders alike)
RUN = 3             # samples in a row held there: clipping, not a peak
WINDOW = 0.5        # seconds per window for vocal presence
VOICE_DBFS = -35.0  # a window's stem quieter than this is leakage
VOICE_SHARE = 0.25  # and a stem under this share of the window's energy is too


def clipping(samples: np.ndarray) -> dict:
    """samples: [channels, n] float. Peak in dBFS (None for silence) and the share of samples in clipped runs."""
    x = np.abs(np.asarray(samples, dtype=np.float32))
    if x.ndim == 1:
        x = x[None]
    peak = float(x.max()) if x.size else 0.0
    if peak <= 0.0:
        return {"peak_dbfs": None, "clipped_ratio": 0.0}
    clipped = 0
    for ch in x:
        # A run held at full scale; overs past it in a float render are not flat.
        at = (ch >= FULL_SCALE) & (ch <= 1.0 + 1e-6)
        if not at.any():
            continue
        edges = np.diff(np.concatenate([[0], at.astype(np.int8), [0]]))
        starts, ends = np.flatnonzero(edges == 1), np.flatnonzero(edges == -1)
        lengths = ends - starts
        clipped += int(lengths[lengths >= RUN].sum())
    return {
        "peak_dbfs": round(20 * math.log10(peak), 2),
        "clipped_ratio": round(clipped / x.size, 6),
    }


def vocal_presence(vocal: np.ndarray, mix: np.ndarray, sr: int) -> dict:
    """vocal, mix: mono float at sr. The stem's share of the energy, and seconds with a voice in them."""
    v = np.asarray(vocal, dtype=np.float64)
    m = np.asarray(mix, dtype=np.float64)
    n = min(len(v), len(m))
    v, m = v[:n], m[:n]
    total = float(np.sum(m * m))
    ratio = float(np.sum(v * v)) / total if total > 0 else 0.0
    hop = max(1, int(round(sr * WINDOW)))
    frames = n // hop
    seconds = 0.0
    if frames:
        ve = np.mean(v[: frames * hop].reshape(frames, hop) ** 2, axis=1)
        me = np.mean(m[: frames * hop].reshape(frames, hop) ** 2, axis=1)
        loud = 10 * np.log10(np.maximum(ve, 1e-12)) >= VOICE_DBFS
        share = ve >= VOICE_SHARE * np.maximum(me, 1e-12)
        seconds = float(np.count_nonzero(loud & share)) * WINDOW
    return {"vocal_ratio": round(min(ratio, 1.0), 4), "vocal_seconds": round(seconds, 1)}


def measure(path, *, instrumental: bool, decode, stem=None) -> dict:
    """The quality half of the render report. `decode(path)` -> ([channels, n], sr); `stem(path)` -> (mono, sr) or None."""
    samples, sr = decode(path)
    out: dict = clipping(samples)
    out["vocal_ratio"] = None
    out["vocal_seconds"] = None
    if instrumental and stem is not None:
        got: Optional[tuple] = stem(path)
        if got is not None:
            vocal, vsr = got
            mix = samples.mean(0)
            if vsr != sr:
                # Compare like with like: the stem at the render's own rate.
                idx = np.minimum((np.arange(len(mix)) * vsr / sr).astype(np.int64), len(vocal) - 1)
                vocal = vocal[idx]
            out.update(vocal_presence(vocal, mix, sr))
    return out
