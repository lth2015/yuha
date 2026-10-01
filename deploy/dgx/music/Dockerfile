# NGC PyTorch = the only arm64 + Blackwell official build. Tag is set in .env (NGC_TAG).
ARG NGC_TAG=25.09-py3
FROM nvcr.io/nvidia/pytorch:${NGC_TAG}

ARG ACE_STEP_REF=main
ENV DEBIAN_FRONTEND=noninteractive PIP_DISABLE_PIP_VERSION_CHECK=1 PYTHONUNBUFFERED=1

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg libsndfile1 git \
    && rm -rf /var/lib/apt/lists/*

# ---- 1. Freeze the container's torch stack (only torch-family; everything else may move).
RUN python - <<'EOF'
import importlib.metadata as m, torch
with open("/opt/torch-constraints.txt", "w") as f:
    for p in ["torch", "torchvision", "triton"]:
        try: f.write(f"{p}=={m.version(p)}\n")
        except m.PackageNotFoundError: pass
open("/opt/torch-before.txt", "w").write(torch.__version__)
print(open("/opt/torch-constraints.txt").read())
EOF
# NGC ships its own /etc/pip/constraint.txt whose pins clash with ACE-Step's; use only ours.
ENV PIP_CONSTRAINT=/opt/torch-constraints.txt

# ---- 2. torchaudio: NGC does not ship it, and the PyPI wheel would drag in a different torch.
#         Build it from source against the container's torch (CPU ext only; ACE-Step only needs
#         transforms.Resample / MelScale; save() is replaced by soundfile in app.py).
RUN python -c "import torchaudio" 2>/dev/null && echo "torchaudio present" || ( \
      V=$(python -c "import torch;print('.'.join(torch.__version__.split('+')[0].split('a')[0].split('.')[:2]))") ; \
      echo "building torchaudio for torch $V" ; \
      (git clone -q --depth 1 --branch v$V.0 https://github.com/pytorch/audio /tmp/audio \
        || git clone -q --depth 1 https://github.com/pytorch/audio /tmp/audio) && \
      cd /tmp/audio && USE_CUDA=0 USE_FFMPEG=0 BUILD_SOX=0 BUILD_RNNT=0 BUILD_CTC_DECODER=0 \
        pip install --no-build-isolation --no-deps . && \
      cd / && rm -rf /tmp/audio && python -c "import torchaudio, torchaudio.transforms as T; print('torchaudio', torchaudio.__version__); T.Resample(48000,44100); T.MelScale()" )

# ---- 3. ACE-Step: inference deps only, pins relaxed so they can coexist with the NGC stack.
WORKDIR /opt
RUN git clone https://github.com/ace-step/ACE-Step.git && cd ACE-Step && git checkout ${ACE_STEP_REF} && git log -1 --oneline
RUN pip install \
      "diffusers>=0.33.0" "transformers==4.50.0" "accelerate>=1.6.0" peft \
      "librosa>=0.11.0" "soundfile>=0.13.1" loguru tqdm click huggingface_hub \
      "pypinyin==0.53.0" "py3langid==0.3.0" "hangul-romanize==0.1.0" "num2words==0.5.14" \
      "spacy>=3.8,<3.9" opencc-python-reimplemented
# Japanese lyric helpers: best effort (may lack arm64 wheels; only used for Japanese lyrics)
RUN pip install cutlet "fugashi[unidic-lite]" || echo "WARN: Japanese lyric helpers not installed"
RUN cd ACE-Step && pip install --no-deps -e .

COPY server/requirements.txt /opt/server-requirements.txt
RUN pip install -r /opt/server-requirements.txt
# Lyric alignment (POST /v1/align): openai-whisper is plain PyTorch, so it runs
# on the container's arm64 CUDA torch. The torch constraint keeps it from
# pulling its own.
RUN pip install openai-whisper

# ---- 4. Hard fail the build if torch got replaced / lost CUDA, or ACE-Step can't import.
# No GPU driver exists during `docker build`, so libcuda.so.1 is absent; transformer_engine
# (pulled in via peft) dlopens it at import. Use the CUDA stub for this check only —
# at runtime the NVIDIA container toolkit injects the real driver library.
RUN mkdir -p /tmp/cudastub && ln -sf /usr/local/cuda/lib64/stubs/libcuda.so /tmp/cudastub/libcuda.so.1 && \
    LD_LIBRARY_PATH=/tmp/cudastub:$LD_LIBRARY_PATH python - <<'EOF'
import torch
before = open("/opt/torch-before.txt").read().strip()
print("torch", torch.__version__, "cuda", torch.version.cuda)
assert torch.__version__ == before, f"torch was replaced: {before} -> {torch.__version__}"
assert torch.version.cuda, "torch has no CUDA build"
from acestep.pipeline_ace_step import ACEStepPipeline  # noqa
import whisper  # noqa
from acestep.language_segmentation import LangSegment
LangSegment()  # py3langid API check (0.4.0 removed from_pickled_model)
from acestep.models.lyrics_utils.lyric_tokenizer import VoiceBpeTokenizer  # noqa
print("ACE-Step import OK")
EOF
RUN rm -rf /tmp/cudastub

COPY server/ /opt/server/
WORKDIR /opt/server
EXPOSE 8000
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--timeout-keep-alive", "30"]
