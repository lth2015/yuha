"""Deterministic FFmpeg filter construction for YUHA's delivery master."""

from __future__ import annotations

from typing import Callable, Optional


def validate_tone(tone: str) -> str:
    normalized = tone.lower()
    if normalized not in {"conservative", "off"}:
        raise ValueError(
            f"unsupported MASTER_TONE={tone!r}; use conservative or off"
        )
    return normalized


TONE_CONSERVATIVE = [
    "highpass=f=28:p=2",
    "lowpass=f=18000:p=2",
    "equalizer=f=190:t=q:w=1.1:g=0.8",
    "equalizer=f=3000:t=q:w=1.2:g=-1.25",
    "acompressor=threshold=-18dB:ratio=1.25:attack=20:release=180:makeup=1",
]


def tone_filters(tone: str) -> list[str]:
    return list(TONE_CONSERVATIVE) if validate_tone(tone) == "conservative" else []


def fade_filters(fade_in_ms: int, fade_out_ms: int, want_seconds: float) -> list[str]:
    out: list[str] = []
    if fade_in_ms > 0:
        out.append(f"afade=t=in:st=0:d={fade_in_ms / 1000:.3f}")
    if fade_out_ms > 0:
        start = max(0.0, want_seconds - fade_out_ms / 1000)
        out.append(f"afade=t=out:st={start:.3f}:d={fade_out_ms / 1000:.3f}")
    return out


def build_filters(
    *,
    tone: str,
    lufs: float,
    true_peak: float,
    lra: float,
    fade_in_ms: int,
    fade_out_ms: int,
    want_seconds: float,
) -> list[str]:
    """Return WAV-domain finishing filters in their required processing order."""
    return [*tone_filters(tone), f"loudnorm=I={lufs}:TP={true_peak}:LRA={lra}",
            *fade_filters(fade_in_ms, fade_out_ms, want_seconds)]


def build_linear_filters(
    *,
    tone: str,
    gain_db: float,
    ceiling_db: float,
    fade_in_ms: int,
    fade_out_ms: int,
    want_seconds: float,
) -> list[str]:
    """
    The same tone and fades, with loudness set by one fixed gain and peaks held
    by a limiter, instead of `loudnorm`.

    Why it exists (measured 2026-11-28): single-pass `loudnorm` is its dynamic
    mode, a gain that follows the music over ~3 s windows. On a test signal
    with a chorus 6 dB above its verse it left 2.9 dB; this chain left 4.4.
    Two-pass `linear=true` does not help, because loudnorm drops back to
    dynamic whenever the fixed gain would break the true-peak ceiling, which
    it does for any render that needs lifting to -14 LUFS.

    A limiter acts in milliseconds on transients; a section-to-section level
    difference passes through it. ``gain_db`` is found by ``fit_gain``.
    """
    ceiling = 10 ** (ceiling_db / 20)
    return [*tone_filters(tone), f"volume={gain_db:.2f}dB",
            f"alimiter=limit={ceiling:.4f}:attack=5:release=50:level=false",
            *fade_filters(fade_in_ms, fade_out_ms, want_seconds)]


def fit_gain(lufs_after: "Callable[[float], Optional[float]]", target: float, start: float,
             passes: int = 2) -> float:
    """
    The gain that lands ``target`` LUFS once the limiter has taken its share:
    apply, measure, correct. Two passes land within ~0.2 LU on real music.
    """
    gain = start
    for _ in range(passes):
        got = lufs_after(gain)
        if got is None:
            break
        gain += target - got
    return gain
