"""Deterministic FFmpeg filter construction for YUHA's delivery master."""

from __future__ import annotations


def validate_tone(tone: str) -> str:
    normalized = tone.lower()
    if normalized not in {"conservative", "off"}:
        raise ValueError(
            f"unsupported MASTER_TONE={tone!r}; use conservative or off"
        )
    return normalized


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
    tone = validate_tone(tone)
    filters: list[str] = []
    if tone == "conservative":
        filters.extend([
            "highpass=f=28:p=2",
            "lowpass=f=18000:p=2",
            "equalizer=f=190:t=q:w=1.1:g=0.8",
            "equalizer=f=3000:t=q:w=1.2:g=-1.25",
            "acompressor=threshold=-18dB:ratio=1.25:attack=20:release=180:makeup=1",
        ])
    filters.append(f"loudnorm=I={lufs}:TP={true_peak}:LRA={lra}")
    if fade_in_ms > 0:
        filters.append(f"afade=t=in:st=0:d={fade_in_ms / 1000:.3f}")
    if fade_out_ms > 0:
        start = max(0.0, want_seconds - fade_out_ms / 1000)
        filters.append(f"afade=t=out:st={start:.3f}:d={fade_out_ms / 1000:.3f}")
    return filters
