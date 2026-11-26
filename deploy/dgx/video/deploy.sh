#!/usr/bin/env bash
# Ship the clip service to the video box and wait until its model has loaded.
#
# Run on the Mac that can `ssh dgxv`:
#     cd deploy/dgx/video && ./deploy.sh
# Then the bench, on the box:
#     ssh dgxv 'cd ~/yuha-video && python3 bench.py'
#
# Options (env):
#   DGX=dgxv            ssh host. The music box (dgxa) is refused unless SHARED=1:
#                       the spec runs video on its own machine, and on one box the
#                       two models share one pool of unified memory.
#   VIDEO_MODEL=...     weights to load (written to .env on first deploy only)
#   VIDEO_PIPELINE=...  diffusers pipeline class (likewise)
set -euo pipefail
cd "$(dirname "$0")"
DGX="${DGX:-dgxv}"
R='~/yuha-video'
if [[ "$DGX" == dgxa* && "${SHARED:-}" != "1" ]]; then
  echo "refusing to put the video model on the music box ($DGX); SHARED=1 to override" >&2; exit 1
fi

echo "== copying to $DGX:$R"
ssh "$DGX" "mkdir -p $R/server"
tar -cf - Dockerfile docker-compose.yml bench.py server/*.py server/requirements.txt | ssh "$DGX" "tar -xf - -C $R"

ssh "$DGX" VIDEO_MODEL="${VIDEO_MODEL:-}" VIDEO_PIPELINE="${VIDEO_PIPELINE:-}" bash -s <<'REMOTE'
set -euo pipefail
cd ~/yuha-video
if [[ ! -f .env ]]; then
  IP=$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')
  umask 077
  cat > .env <<ENV
NGC_TAG=25.09-py3
HOST_PORT=8100
YUHA_API_KEY=$(openssl rand -hex 24)
CLIP_SIGNING_SECRET=$(openssl rand -hex 32)
CLIP_BASE_URL=http://${IP}:8100
VIDEO_BACKEND=diffusers
VIDEO_MODEL=${VIDEO_MODEL:-Lightricks/LTX-Video}
VIDEO_PIPELINE=${VIDEO_PIPELINE:-LTXPipeline}
VIDEO_DTYPE=bfloat16
VIDEO_STEPS=40
MAX_QUEUE=8
RETENTION_HOURS=48
ENV
  echo "wrote .env (CLIP_BASE_URL=http://${IP}:8100); the key stays on this box"
fi
mkdir -p "$HOME/.cache/huggingface" data
DOCKER_BUILDKIT=1 BUILDKIT_PROGRESS=plain docker compose build 2>&1 | tee build.log
[ "${PIPESTATUS[0]}" -eq 0 ] || { echo "BUILD FAILED:"; grep -n -iE "error|conflict|ResolutionImpossible" build.log | tail -30; exit 1; }
docker compose up -d
P=$(sed -n 's/^HOST_PORT=//p' .env)
echo "== waiting for the model (the first start downloads weights)"
for i in $(seq 1 360); do
  out=$(curl -fsS "http://127.0.0.1:${P:-8100}/healthz" 2>/dev/null || true)
  [[ "$out" == *'"model_loaded":true'* ]] && { echo "$out"; break; }
  [[ "$out" == *'"model_error":"'* ]] && { echo "$out"; docker logs --tail 60 yuha-video; exit 1; }
  sleep 10
done
[[ "$out" == *'"model_loaded":true'* ]] || { echo "model did not load in an hour"; docker logs --tail 60 yuha-video; exit 1; }
# Proof the service is the one answering, not just that something is: a well-formed submit with no key
# must be 401 (an empty body would be 422 from validation, which any FastAPI app gives).
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:${P:-8100}/v1/clips" -H 'content-type: application/json' \
  -d '{"prompt":"probe","width":256,"height":256,"seconds":1}')
[[ "$code" == 401 ]] || { echo "expected 401 from an unauthenticated submit, got $code"; exit 1; }
echo "== deployed. Next: python3 bench.py"
REMOTE
