#!/usr/bin/env bash
# Point the local dev stack at the ACE-Step service on the Spark box, when
# `ssh dgx` is not available (off the office network).
#
# 03_wire_yuha.sh does the same thing but reads the key and the base URL over
# ssh from ~/yuha-spark/.env. From outside that network the host does not
# resolve and port 22 is filtered, while the service itself answers fine on its
# public address — so the only missing piece is the key, and it is passed here.
#
#   ./scripts/wire-spark.sh <YUHA_API_KEY> [http://121.101.82.116:8583]
#   ./scripts/wire-spark.sh --undo
#
# Writes the same marked block 03_wire_yuha.sh writes, so the two do not fight:
# whichever runs last owns the block.
set -euo pipefail
cd "$(dirname "$0")/.."
ENV_FILE=".env"
BEGIN="# >>> spark-music (managed by yuha-spark/03_wire_yuha.sh)"
END="# <<< spark-music"
[[ -f "$ENV_FILE" ]] || { echo "not found: $ENV_FILE"; exit 1; }

cp "$ENV_FILE" "$ENV_FILE.bak-$(date +%Y%m%d%H%M%S)"
awk -v b="$BEGIN" -v e="$END" '$0==b{skip=1;next} $0==e{skip=0;next} !skip' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
[[ "${1:-}" == "--undo" ]] && { echo "removed spark-music block; back on the demo music adapter"; exit 0; }

KEY="${1:-}"
BASE="${2:-http://121.101.82.116:8583}"
[[ -n "$KEY" ]] || { echo "usage: $0 <YUHA_API_KEY> [base-url]   (key lives in ~/yuha-spark/.env on the box)"; exit 1; }
HOST=$(sed -E 's#^https?://([^:/]+).*#\1#' <<<"$BASE")

# Fail before writing anything if the key is wrong: a 401 here is much cheaper
# to read than a worker that accepts jobs and fails every one of them.
#
# GET a job id that cannot exist. The service authenticates before it looks the
# id up, so a wrong key is 401 and a right one is 404 — and neither queues any
# work. Do not probe with POST /v1/jobs: request-body validation runs *before*
# auth there, so a deliberately invalid body returns 422 whatever the key is,
# and the check passes for a key that is wrong. It did, on the first draft.
# curl prints 000 on a connection failure *and* exits non-zero, so a trailing
# `|| echo 000` produced "000\n000" — which matched neither 000 nor anything
# else and fell through to "wiring anyway", writing a config block for a
# service that could not be reached at all.
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 \
  -H "authorization: Bearer $KEY" "$BASE/v1/jobs/wiring-check-no-such-job" 2>/dev/null) || true
[[ -n "$code" ]] || code=000
case "$code" in
  401|403) echo "✗ the service rejected that key ($code). Check YUHA_API_KEY in ~/yuha-spark/.env"; exit 1;;
  000) echo "✗ could not reach $BASE"; exit 1;;
  404|200) ;;  # authenticated; the id is simply not there
  *) echo "note: unexpected status $code from $BASE/v1/jobs/<id> — wiring anyway";;
esac

cat >> "$ENV_FILE" <<BLOCK

$BEGIN
# Self-hosted ACE-Step on the DGX Spark, over its public address. Development
# only: MUSIC_ALLOW_INSECURE_SELF_HOSTED turns off the https and private-address
# checks in the audio fetcher, and loadConfig refuses it in production.
MUSIC_ADAPTER=http
MUSIC_PROVIDER_ID=ace-step-spark
MUSIC_BASE_URL=$BASE
MUSIC_API_KEY=$KEY
MUSIC_MODEL=ace-step
MUSIC_CONTRACT_VERSION=selfhosted-dev
MUSIC_LICENSE_VERSION=selfhosted-dev
MUSIC_SUBMIT_PATH=/v1/jobs
MUSIC_POLL_PATH=/v1/jobs/{id}
MUSIC_REQUEST_ID_FIELD=id
MUSIC_STATUS_FIELD=status
MUSIC_AUDIO_URL_FIELD=audio_url
MUSIC_STATUS_MAP={"pending":["queued","running"],"completed":["succeeded"],"failed":["failed"],"rejected":["rejected"]}
MUSIC_IDEMPOTENCY_HEADER=Idempotency-Key
MUSIC_ALLOWED_AUDIO_HOSTS=$HOST
MUSIC_ALLOW_INSECURE_SELF_HOSTED=true
MUSIC_SUPPORTS_INSTRUMENTAL=true
MUSIC_SUPPORTS_CANCEL=false
MUSIC_SUPPORTS_WEBHOOK=false
MUSIC_SUPPORTS_STATUS_QUERY=true
MUSIC_COMMERCIAL_DELIVERY=false
MUSIC_MAX_CONCURRENCY=1
MUSIC_DATA_REGION=self-hosted-lan-jp
ALIGNMENT_ADAPTER=http
ALIGNMENT_PROVIDER_ID=spark-whisper
ALIGNMENT_BASE_URL=$BASE
ALIGNMENT_API_KEY=$KEY
ALIGNMENT_SUBMIT_PATH=/v1/align
ALIGNMENT_LINES_FIELD=lines
ALIGNMENT_LINE_TEXT_FIELD=text
ALIGNMENT_LINE_START_FIELD=start
ALIGNMENT_LINE_END_FIELD=end
ALIGNMENT_SECTION_FIELD=section
ALIGNMENT_WORDS_FIELD=words
ALIGNMENT_WORD_TEXT_FIELD=w
ALIGNMENT_WORD_START_FIELD=start
ALIGNMENT_WORD_END_FIELD=end
ALIGNMENT_AUDIO_URL_TEMPLATE=$BASE/v1/audio/{id}.mp3
ALIGNMENT_TIMEOUT_MS=180000
$END
BLOCK
echo "✓ wired: $BASE (audio host $HOST). Restart the API and worker to pick it up."
