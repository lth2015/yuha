#!/usr/bin/env bash
# Step 1: write .env, build image (fails loudly if torch gets swapped), start service with auto-restart.
set -euo pipefail
cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
  TAG=$(sed -n 's/^NGC_TAG=//p' .env.tag 2>/dev/null || true)
  IP=$(ip -4 route get 1.1.1.1 | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}')
  cat > .env <<EOF
NGC_TAG=${TAG:-25.09-py3}
ACE_STEP_REF=main
YUHA_API_KEY=$(openssl rand -hex 24)
AUDIO_SIGNING_SECRET=$(openssl rand -hex 32)
AUDIO_BASE_URL=http://${IP}:8000
AUDIO_URL_TTL_SECONDS=86400
ACE_INFER_STEPS=60
MAX_QUEUE=30
MP3_BITRATE=192k
EOF
  echo "wrote .env (AUDIO_BASE_URL=http://${IP}:8000) — make this IP static, see README"
fi

mkdir -p "$HOME/.cache/ace-step" "$HOME/.cache/huggingface" data
sudo -n systemctl enable --now docker >/dev/null 2>&1 || true   # needed for restart after reboot

DOCKER_BUILDKIT=1 BUILDKIT_PROGRESS=plain docker compose build 2>&1 | tee build.log; [ "${PIPESTATUS[0]}" -eq 0 ] || { echo "BUILD FAILED — real error:"; grep -n -iE "error|conflict|ResolutionImpossible|No matching distribution" build.log | tail -40; exit 1; }
# pick host port: keep .env HOST_PORT if set, else 8000, else first free of 8010..8019
if ! grep -q '^HOST_PORT=' .env; then
  PORT=8000
  if ss -ltn | awk '{print $4}' | grep -qE "[:.]8000$"; then
    echo "port 8000 is taken by:"; { sudo -n ss -ltnp 2>/dev/null || ss -ltnp; } | grep -E ":8000\b" || true
    for p in $(seq 8010 8019); do ss -ltn | awk '{print $4}' | grep -qE "[:.]$p$" || { PORT=$p; break; }; done
  fi
  echo "HOST_PORT=$PORT" >> .env
  sed -i -E "s#^(AUDIO_BASE_URL=http://[^:]+):[0-9]+#\1:$PORT#" .env
fi
HOST_PORT=$(sed -n 's/^HOST_PORT=//p' .env)
echo "using host port $HOST_PORT  ($(grep AUDIO_BASE_URL .env))"
docker compose up -d
echo "== waiting for model load (first run downloads weights, can take a while) =="
for i in $(seq 1 180); do
  out=$(curl -fsS http://127.0.0.1:${HOST_PORT}/healthz 2>/dev/null || true)
  [[ "$out" == *'"model_loaded":true'* ]] && { echo "$out"; break; }
  [[ "$out" == *'"model_error":"'* ]] && { echo "$out"; echo "MODEL LOAD FAILED"; docker logs --tail 80 yuha-music; exit 1; }
  sleep 10
done
docker logs --tail 20 yuha-music
echo "== deployed. Next: ./02_acceptance.sh =="
