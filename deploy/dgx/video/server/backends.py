"""
What draws a clip. The service (app.py) owns the queue, the files and the
rules; a backend only turns one request into one silent MP4 on disk.

  fake      ffmpeg's test pattern. No GPU, no weights: for the unit tests and
            for wiring YUHA up before the model is chosen.
  diffusers a text-to-video pipeline loaded through Hugging Face diffusers.
            The pipeline class and the weights are configuration, because the
            model is not decided (docs/AI_SCENE_MV_TICKETS.md, T2): the spec's
            candidate is LTX-2.5, and whether it ships in diffusers, under what
            licence and on this box is exactly what T2 has to establish. The
            default here, LTX-Video through `LTXPipeline`, is a baseline that
            gives the bench numbers to compare against — not a choice.

Every backend's output is re-muxed with `-an` before it is accepted, and the
service checks with ffprobe that no audio stream is left: the finished MV
carries only the song (spec: 丢弃模型生成音轨).
"""
from __future__ import annotations

import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional


@dataclass
class ClipRequest:
    prompt: str
    negative_prompt: str
    width: int
    height: int
    frames: int
    fps: int
    steps: int
    seed: Optional[int]


@dataclass
class ClipResult:
    seconds_generating: float
    peak_memory_gb: Optional[float]
    model: str


class Cancelled(Exception):
    """Raised between denoising steps when the clip's job was cancelled."""


def frames_for(seconds: float, fps: int, multiple: int) -> int:
    """LTX-style pipelines take `multiple * k + 1` frames; the nearest at or above the ask."""
    want = max(1, round(seconds * fps))
    k = max(1, -(-(want - 1) // multiple))
    return multiple * k + 1


class FakeBackend:
    name = "fake"
    size_multiple = 32
    frame_multiple = 8

    def __init__(self, delay: float = 0.0):
        self.delay = delay
        self.loaded = True
        self.error: Optional[str] = None

    def load(self) -> None:
        pass

    def render(self, req: ClipRequest, out: Path, should_stop) -> ClipResult:
        t0 = time.time()
        end = t0 + self.delay
        while time.time() < end:
            if should_stop():
                raise Cancelled()
            time.sleep(0.02)
        subprocess.run(
            ["ffmpeg", "-loglevel", "error", "-y", "-f", "lavfi",
             "-i", f"testsrc2=size={req.width}x{req.height}:rate={req.fps}",
             "-frames:v", str(req.frames), "-pix_fmt", "yuv420p", "-an", str(out)],
            check=True,
        )
        return ClipResult(seconds_generating=round(time.time() - t0, 2), peak_memory_gb=None, model="fake")


class DiffusersBackend:
    name = "diffusers"

    def __init__(self) -> None:
        self.model_id = os.environ.get("VIDEO_MODEL", "Lightricks/LTX-Video")
        self.pipeline_class = os.environ.get("VIDEO_PIPELINE", "LTXPipeline")
        self.dtype = os.environ.get("VIDEO_DTYPE", "bfloat16")
        self.size_multiple = int(os.environ.get("VIDEO_SIZE_MULTIPLE", "32"))
        self.frame_multiple = int(os.environ.get("VIDEO_FRAME_MULTIPLE", "8"))
        self.pipe = None
        self.loaded = False
        self.error: Optional[str] = None

    def load(self) -> None:
        import diffusers
        import torch

        cls = getattr(diffusers, self.pipeline_class)
        self.pipe = cls.from_pretrained(self.model_id, torch_dtype=getattr(torch, self.dtype)).to("cuda")
        self.loaded = True

    def render(self, req: ClipRequest, out: Path, should_stop) -> ClipResult:
        import torch
        from diffusers.utils import export_to_video

        torch.cuda.reset_peak_memory_stats()
        gen = torch.Generator(device="cuda")
        if req.seed is not None:
            gen.manual_seed(req.seed)

        def on_step(pipe, step, timestep, kwargs):
            # A cancel lands between steps: the shared model is never killed mid-call.
            if should_stop():
                raise Cancelled()
            return kwargs

        t0 = time.time()
        try:
            return self._render(req, out, gen, on_step, t0)
        finally:
            # A failed or cancelled run must not leave its blocks cached: on Spark that
            # memory is the music service's too, and the next clip's numbers would carry it.
            import gc
            gc.collect()
            torch.cuda.empty_cache()

    def _render(self, req, out, gen, on_step, t0):
        import torch
        from diffusers.utils import export_to_video

        result = self.pipe(
            prompt=req.prompt,
            negative_prompt=req.negative_prompt or None,
            width=req.width,
            height=req.height,
            num_frames=req.frames,
            num_inference_steps=req.steps,
            generator=gen,
            callback_on_step_end=on_step,
        )
        torch.cuda.synchronize()
        seconds = time.time() - t0
        raw = out.with_suffix(".raw.mp4")
        export_to_video(result.frames[0], str(raw), fps=req.fps)
        try:
            subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(raw), "-an",
                            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18", str(out)], check=True)
        finally:
            raw.unlink(missing_ok=True)
        peak = torch.cuda.max_memory_allocated() / 1e9
        return ClipResult(seconds_generating=round(seconds, 2), peak_memory_gb=round(peak, 2),
                          model=f"{self.pipeline_class}:{self.model_id}")


def make_backend():
    kind = os.environ.get("VIDEO_BACKEND", "diffusers")
    if kind == "fake":
        return FakeBackend(delay=float(os.environ.get("FAKE_DELAY_SECONDS", "0")))
    if kind == "diffusers":
        return DiffusersBackend()
    raise ValueError(f"unknown VIDEO_BACKEND {kind!r}")
