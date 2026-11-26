# Same base as the music service: NGC PyTorch is the arm64 + Blackwell build for DGX Spark.
ARG NGC_TAG=25.09-py3
FROM nvcr.io/nvidia/pytorch:${NGC_TAG}

ENV DEBIAN_FRONTEND=noninteractive PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONUNBUFFERED=1
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

# Freeze the container's torch stack; nothing below may replace it.
RUN python - <<'PY'
import importlib.metadata as m, torch
with open("/opt/torch-constraints.txt", "w") as f:
    for p in ["torch", "torchvision", "triton"]:
        try: f.write(f"{p}=={m.version(p)}\n")
        except m.PackageNotFoundError: pass
open("/opt/torch-before.txt", "w").write(torch.__version__)
PY
ENV PIP_CONSTRAINT=/opt/torch-constraints.txt

ARG DIFFUSERS_SPEC="diffusers>=0.32"
COPY server/requirements.txt /opt/server-requirements.txt
RUN pip install "${DIFFUSERS_SPEC}" -r /opt/server-requirements.txt

# Fail the build if torch was swapped or lost CUDA, or the pipeline class is missing.
# No driver exists at build time; the CUDA stub stands in for this check only.
ARG VIDEO_PIPELINE=LTXPipeline
RUN mkdir -p /tmp/cudastub && ln -sf /usr/local/cuda/lib64/stubs/libcuda.so /tmp/cudastub/libcuda.so.1 && \
    LD_LIBRARY_PATH=/tmp/cudastub:$LD_LIBRARY_PATH VIDEO_PIPELINE=${VIDEO_PIPELINE} python - <<'PY'
import os, torch, diffusers
before = open("/opt/torch-before.txt").read().strip()
print("torch", torch.__version__, "cuda", torch.version.cuda, "diffusers", diffusers.__version__)
assert torch.__version__ == before, f"torch was replaced: {before} -> {torch.__version__}"
assert torch.version.cuda, "torch has no CUDA build"
getattr(diffusers, os.environ["VIDEO_PIPELINE"])
from diffusers.utils import export_to_video  # noqa
print("pipeline import OK")
PY
RUN rm -rf /tmp/cudastub

COPY server/ /opt/server/
WORKDIR /opt/server
EXPOSE 8100
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8100", "--workers", "1", "--timeout-keep-alive", "30"]
