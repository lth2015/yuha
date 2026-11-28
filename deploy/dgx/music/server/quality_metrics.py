"""
The arithmetic behind bench_quality.py, on feature arrays only (numpy, no
audio libraries), so it is tested in CI where librosa and the GPU are absent.

Every function here answers one question a producer would ask of a pop song,
as a number with its own control, because a similarity on its own says little:
two passages in the same key always look somewhat alike in chroma.

  - Does the chorus come back recognisably? chorus-to-chorus similarity,
    against chorus-to-verse as the control.
  - Does the intro's figure return in the chorus? the intro's best match
    inside the chorus melody, against its best match inside the verse.
  - Does the chorus lift? loudness, brightness and density, chorus minus verse.
  - Does it stay in key and in time? key agreement across windows; beat
    interval variation.
  - Does it end, or stop? the level of the closing seconds against the body.

These are measurements, not taste. What they cannot tell — whether the hook
is any good — they do not claim to.
"""
from __future__ import annotations

import math
from typing import Dict, List, Optional, Sequence, Tuple

import numpy as np

# Krumhansl–Kessler key profiles (major, minor), tonic first.
_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
KEY_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]


def _unit_columns(x: np.ndarray) -> np.ndarray:
    x = np.asarray(x, dtype=np.float64)
    n = np.linalg.norm(x, axis=0, keepdims=True)
    return x / np.where(n > 1e-12, n, 1.0)


def _cost(a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """1 − cosine similarity between every column of a and every column of b."""
    return 1.0 - _unit_columns(a).T @ _unit_columns(b)


def dtw_similarity(a: np.ndarray, b: np.ndarray) -> Optional[float]:
    """
    How alike two feature sequences (rows = features, columns = frames) are
    once their timing is allowed to differ: 1 − the mean cost along the best
    alignment. 1 is identical; ~0.5 is unrelated material in one key.
    """
    if a.shape[1] == 0 or b.shape[1] == 0:
        return None
    c = _cost(a, b)
    n, m = c.shape
    acc = np.full((n + 1, m + 1), np.inf)
    steps = np.zeros((n + 1, m + 1))
    acc[0, 0] = 0.0
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            prev = min((acc[i - 1, j - 1], steps[i - 1, j - 1]), (acc[i - 1, j], steps[i - 1, j]), (acc[i, j - 1], steps[i, j - 1]))
            acc[i, j] = c[i - 1, j - 1] + prev[0]
            steps[i, j] = prev[1] + 1
    return float(1.0 - acc[n, m] / steps[n, m])


def best_match(query: np.ndarray, target: np.ndarray) -> Optional[float]:
    """
    Where in `target` does `query` fit best, and how well? Subsequence DTW:
    the query is aligned whole, the target may start and end anywhere. For
    "is the intro's figure inside the chorus?", the figure is short and the
    chorus long.
    """
    if query.shape[1] == 0 or target.shape[1] == 0:
        return None
    c = _cost(query, target)
    n, m = c.shape
    acc = np.full((n + 1, m + 1), np.inf)
    steps = np.zeros((n + 1, m + 1))
    acc[0, :] = 0.0  # free start anywhere in the target
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            prev = min((acc[i - 1, j - 1], steps[i - 1, j - 1]), (acc[i - 1, j], steps[i - 1, j]), (acc[i, j - 1], steps[i, j - 1]))
            acc[i, j] = c[i - 1, j - 1] + prev[0]
            steps[i, j] = prev[1] + 1
    j = int(np.argmin(acc[n, 1:] / np.maximum(steps[n, 1:], 1))) + 1  # free end
    return float(1.0 - acc[n, j] / steps[n, j])


def downsample(x: np.ndarray, frames_per_step: int) -> np.ndarray:
    """Mean over consecutive groups of columns: DTW cost is quadratic, a song is long."""
    if frames_per_step <= 1 or x.shape[1] == 0:
        return x
    n = x.shape[1] // frames_per_step
    if n == 0:
        return x.mean(axis=1, keepdims=True)
    return x[:, : n * frames_per_step].reshape(x.shape[0], n, frames_per_step).mean(axis=2)


def key_of(chroma_mean: np.ndarray) -> Tuple[str, float]:
    """Krumhansl–Schmuckler: the key whose profile correlates best with the pitch-class weight."""
    v = np.asarray(chroma_mean, dtype=np.float64)
    if not np.any(v > 0):
        return ("?", 0.0)
    best = ("?", -2.0)
    for tonic in range(12):
        for profile, mode in ((_MAJOR, "major"), (_MINOR, "minor")):
            r = float(np.corrcoef(v, np.roll(profile, tonic))[0, 1])
            if r > best[1]:
                best = (f"{KEY_NAMES[tonic]} {mode}", r)
    return best


def _key_family(name: str) -> Optional[int]:
    """A key and its relative minor/major share a scale: C major and A minor are one family (C)."""
    if name == "?":
        return None
    tonic, mode = name.split(" ")
    i = KEY_NAMES.index(tonic)
    return i if mode == "major" else (i + 3) % 12


def key_consistency(chroma: np.ndarray, frames_per_window: int) -> Tuple[str, Optional[float]]:
    """
    The song's key, and the share of windows in it. A window that reads as the
    relative minor (or major) agrees: a verse leaning on A minor in a C major
    song is ordinary pop, not a change of key.
    """
    if chroma.shape[1] == 0:
        return ("?", None)
    overall, _ = key_of(chroma.mean(axis=1))
    n = chroma.shape[1] // max(1, frames_per_window)
    if n == 0:
        return (overall, None)
    home = _key_family(overall)
    agree = sum(_key_family(key_of(chroma[:, i * frames_per_window:(i + 1) * frames_per_window].mean(axis=1))[0]) == home
                for i in range(n))
    return (overall, agree / n)


def periodicity_bpm(envelope: Sequence[float], hop_s: float, lo_bpm: float = 60.0, hi_bpm: float = 200.0,
                    near: Optional[float] = None) -> Optional[float]:
    """
    The tempo an onset envelope repeats at, read from its own autocorrelation:
    the strongest lag between ``lo_bpm`` and ``hi_bpm``, then refined to
    0.1 BPM, because whole-frame lags are ~5% apart and the reference allows
    3%.

    Each half of a song gets its own reading. A beat tracker cannot be used
    for that: it fixes one tempo for the whole file and then places beats at
    that spacing, so both halves come back identical by construction. That is
    how the first drift measure read 0.0 → 0.0 on a planted 15% slowdown on
    the DGX (2026-11-28).

    A periodic envelope correlates as well at two beats as at one, so the
    shortest lag within 80% of the strongest wins. ``near`` narrows the
    search to within 25% of a tempo already read (the whole song's), so two
    halves cannot land on different metrical levels — a half read at 3/2 the
    other's would otherwise look like a 33% change.
    """
    e = np.asarray(envelope, dtype=np.float64)
    # Onsets land on whole frames, so a beat 21.5 frames long alternates 21 and
    # 22 and its one-beat peak smears while the two-beat one stays sharp.
    # A ~20 ms blur makes the one-beat peak as tall as it should be.
    e = np.convolve(e, [0.25, 0.5, 0.25], mode="same")
    e = e - e.mean()
    lo, hi = int(np.floor(60.0 / hi_bpm / hop_s)), int(np.ceil(60.0 / lo_bpm / hop_s))
    if e.size < hi * 4 or not np.any(e):
        return None
    ac = np.correlate(e, e, mode="full")[e.size - 1:]
    ac = ac / np.arange(e.size, 0, -1)  # unbiased: long lags are not penalised for overlapping less
    if near:
        lo = max(lo, int(np.floor(60.0 / (near * 1.25) / hop_s)))
        hi = min(hi, int(np.ceil(60.0 / (near / 1.25) / hop_s)))
    seg = ac[lo:hi + 1]
    if seg.size < 3 or seg.max() <= 0:
        return None
    peaks = [i for i in range(1, seg.size - 1) if seg[i] >= seg[i - 1] and seg[i] >= seg[i + 1] and seg[i] >= 0.8 * seg.max()]
    k = lo + (peaks[0] if peaks else int(np.argmax(seg)))
    coarse = 60.0 / (k * hop_s)
    # A lag is a whole number of frames, about 5% apart at 120 BPM: too coarse
    # to tell a steady song from a 3% drift. Refine on a 0.1 BPM grid by how
    # strongly the envelope oscillates at that tempo and its first harmonics
    # (an exact-frequency DFT, which no frame grid limits).
    n = np.arange(e.size) * hop_s
    grid = np.arange(coarse * 0.94, coarse * 1.06, 0.1)
    score = [sum(abs(np.dot(e, np.exp(-2j * np.pi * h * (bpm / 60.0) * n))) / h for h in (1, 2, 3)) for bpm in grid]
    return float(grid[int(np.argmax(score))])


def tempo_drift(first_bpm: Optional[float], second_bpm: Optional[float]) -> Optional[float]:
    """
    How far the second half's tempo is from the first half's: |ratio − 1|,
    after folding octaves (a half read at double time is not a song twice as
    fast). A song that slows by 15% halfway reads 0.15.
    """
    if not first_bpm or not second_bpm:
        return None
    r = second_bpm / first_bpm
    while r >= 1.5:
        r /= 2.0
    while r < 0.75:
        r *= 2.0
    return float(abs(r - 1.0))


def interval_cv(times: Sequence[float]) -> Optional[float]:
    """Coefficient of variation of the gaps between beats: 0 is a metronome."""
    t = np.asarray(times, dtype=np.float64)
    if t.size < 8:
        return None
    d = np.diff(t)
    return float(d.std() / d.mean()) if d.mean() > 0 else None


def ending(rms_db: np.ndarray, hop_s: float, fade_s: float = 1.0, window_s: float = 4.0) -> Dict[str, Optional[float]]:
    """
    The closing seconds (before the master's own fade) against the body of
    the song. A song that resolves gets quieter or thinner; one that stops was
    cut off at full level and only the mastering fade lowers it.
    """
    r = np.asarray(rms_db, dtype=np.float64)
    fade = int(round(fade_s / hop_s))
    win = int(round(window_s / hop_s))
    if r.size < fade + win + 10:
        return {"close_minus_body_db": None}
    body = float(np.median(r[: r.size - fade - win]))
    close = float(np.mean(r[r.size - fade - win: r.size - fade]))
    return {"close_minus_body_db": round(close - body, 2)}


def db(x: float) -> float:
    return 20 * math.log10(max(float(x), 1e-12))


def sign_test(deltas: Sequence[Optional[float]]) -> Dict[str, Optional[float]]:
    """B better / worse / equal across pairs, and the two-sided exact sign-test p (ties dropped)."""
    d = [x for x in deltas if x is not None]
    pos = sum(1 for x in d if x > 0)
    neg = sum(1 for x in d if x < 0)
    n = pos + neg
    if n == 0:
        return {"b_higher": pos, "b_lower": neg, "n": len(d), "p": None}
    k = min(pos, neg)
    p = min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n)
    return {"b_higher": pos, "b_lower": neg, "n": len(d), "p": round(p, 3)}
