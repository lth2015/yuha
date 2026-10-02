#!/usr/bin/env bash
# Run ON the Spark box. Prints the service's API key and public base URL, so
# they can be sent to someone wiring up a dev machine from outside the network.
#
#   ./06_print_api_key.sh
#   ./06_print_api_key.sh ~/somewhere-else/.env     (if the deploy lives elsewhere)
#
# 03_wire_yuha.sh normally fetches these over `ssh dgx`. Off the office network
# that host does not resolve and ssh is filtered, while the service itself
# answers on its public address — so the key has to travel by hand, and this
# prints exactly the two values needed and nothing else from the file.
#
# The key is checked against the running service before it is printed. A value
# read out of a stale .env that the container was never restarted with would
# otherwise look right and fail later on the other machine, which is the slow
# way to find out.
set -euo pipefail

ENV_FILE="${1:-$HOME/yuha-spark/.env}"
CONTAINER="yuha-music"

read_env() { [[ -f "$ENV_FILE" ]] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }

KEY="$(read_env YUHA_API_KEY || true)"
BASE="$(read_env AUDIO_BASE_URL || true)"
PORT="$(read_env HOST_PORT || true)"

# The file is the record, but the container is what is actually serving. If the
# file is missing or was edited without a restart, ask the process itself.
if [[ -z "$KEY" ]] && command -v docker >/dev/null 2>&1; then
  echo "note: no YUHA_API_KEY in $ENV_FILE — reading it from the running container" >&2
  KEY="$(docker exec "$CONTAINER" printenv YUHA_API_KEY 2>/dev/null || true)"
fi

if [[ -z "$KEY" ]]; then
  echo "✗ could not find YUHA_API_KEY." >&2
  echo "  Looked in: $ENV_FILE" >&2
  echo "  And in:    docker exec $CONTAINER printenv YUHA_API_KEY" >&2
  echo "  Is this the right machine? Try: ls ~/yuha-spark/.env ; docker ps" >&2
  exit 1
fi

[[ -n "$PORT" ]] || PORT=8583
LOCAL="http://127.0.0.1:$PORT"

# Authenticate against a job id that cannot exist: the service checks the key
# before it looks the id up, so a wrong key is 401 and a right one 404 — and
# neither queues any GPU work. Do not probe with POST /v1/jobs; body validation
# runs before auth there, so 422 comes back whatever the key is.
# curl already prints 000 when it cannot connect, and also exits non-zero; a
# `|| echo 000` on top of that yields "000\n000", which matches no case and
# falls through to the catch-all. Keep curl's own value and only default when
# it printed nothing at all.
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
  -H "authorization: Bearer $KEY" "$LOCAL/v1/jobs/keycheck-no-such-job" 2>/dev/null)" || true
[[ -n "$code" ]] || code=000

case "$code" in
  404|200) verdict="✓ verified against the running service" ;;
  401|403) echo "✗ the service rejects this key ($code). The file and the container disagree." >&2
           echo "  Restart it so they match:  cd ~/yuha-spark && docker compose up -d" >&2
           exit 1 ;;
  000)     verdict="⚠ could not reach $LOCAL — key NOT verified, send it anyway and we will find out" ;;
  *)       verdict="⚠ unexpected status $code from $LOCAL — key NOT verified" ;;
esac

echo
echo "  $verdict"
echo
echo "  Send these two lines back:"
echo
echo "    YUHA_API_KEY=$KEY"
echo "    AUDIO_BASE_URL=${BASE:-http://<this box public IP>:$PORT}"
echo
echo "  Send them in a direct message, not a group channel — this key is the"
echo "  only thing standing between the open internet and this GPU. If it goes"
echo "  somewhere it should not, rotate it:"
echo "    cd ~/yuha-spark && sed -i -E \"s/^YUHA_API_KEY=.*/YUHA_API_KEY=\$(openssl rand -hex 24)/\" .env && docker compose up -d"
echo
