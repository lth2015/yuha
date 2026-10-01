#!/usr/bin/env bash
# Run on your Mac. Puts ACE-Step 1.5 next to v1 on the DGX and runs the vocal bench.
# Production keeps using v1 (ENGINE=v1) until you switch.
#   ./05_try_v15.sh            build + start 1.5, then quick bench (2 songs, v1 vs 1.5 turbo)
#   ./05_try_v15.sh full       ... then the full bench (7 configs x 6 songs x 2 seeds, ~1h)
set -euo pipefail
cd "$(dirname "$0")"
DGX="${DGX:-dgx}"
echo "== upload service code"
scp -q docker-compose.yml "$DGX:yuha-spark/"
scp -q server/app.py server/align.py server/bench_vocals.py "$DGX:yuha-spark/server/"

echo "== start ACE-Step 1.5 (first build + model download can take 20-40 min)"
ssh "$DGX" 'cd ~/yuha-spark && grep -q "^V15_API_KEY=" .env || echo "V15_API_KEY=$(openssl rand -hex 24)" >> .env
  grep -q "^ENGINE=" .env || echo "ENGINE=v1" >> .env
  # the original default of 8 queued jobs turned colleagues away with 429s
  sed -i "s/^MAX_QUEUE=8$/MAX_QUEUE=30/" .env
  mkdir -p ~/.cache/acestep15
  docker compose --profile v15 up -d --build acestep15
  docker compose up -d --build music'

echo "== waiting for 1.5 to answer /health (models load on first start)"
for i in $(seq 1 240); do
  if ssh "$DGX" 'cd ~/yuha-spark && docker compose exec -T music curl -sf http://acestep15:8001/health' >/dev/null 2>&1; then
    echo "   ready"; break; fi
  (( i % 6 == 0 )) && ssh "$DGX" 'docker logs --tail 2 yuha-acestep15 2>&1' | sed 's/^/   /'
  sleep 10
done

BENCH_ARGS="--quick"; [[ "${1:-}" == "full" ]] && BENCH_ARGS=""
echo "== vocal bench ($([[ -z "$BENCH_ARGS" ]] && echo full || echo quick))"
ssh "$DGX" "cd ~/yuha-spark && mkdir -p bench_out && docker compose run --rm -v \$PWD/bench_out:/bench music python /opt/server/bench_vocals.py $BENCH_ARGS"
mkdir -p bench_out && scp -qr "$DGX:yuha-spark/bench_out/." bench_out/
echo "== done: open $(pwd)/bench_out/report.html"
