#!/usr/bin/env bash
# Run on your Mac. Points the YUHA dev stack (this repo) at the ACE-Step service on the Spark.
# Writes a marked block into music/.env (backup kept); re-running replaces the block.
#   ./03_wire_yuha.sh          wire it up
#   ./03_wire_yuha.sh --undo   remove the block (back to the demo music adapter)
set -euo pipefail
cd "$(dirname "$0")"
ENV_FILE="../../../.env"   # repo root (this script lives in deploy/dgx/music)
BEGIN="# >>> spark-music (managed by yuha-spark/03_wire_yuha.sh)"   # marker text kept: existing .env files carry it
END="# <<< spark-music"
[[ -f "$ENV_FILE" ]] || { echo "not found: $ENV_FILE"; exit 1; }
cp "$ENV_FILE" "$ENV_FILE.bak-$(date +%Y%m%d%H%M%S)"
# drop any previous block
awk -v b="$BEGIN" -v e="$END" '$0==b{skip=1;next} $0==e{skip=0;next} !skip' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
[[ "${1:-}" == "--undo" ]] && { echo "removed spark-music block; YUHA back on its default music adapter"; exit 0; }

if grep -qE '^MUSIC_[A-Z_]+=' "$ENV_FILE"; then
  echo "WARN: music/.env already has active MUSIC_* lines outside the block; later lines win:"; grep -nE '^MUSIC_' "$ENV_FILE" | sed -E 's/(KEY)=.*/\1=***/'
fi

REMOTE=$(ssh dgx 'grep -E "^(YUHA_API_KEY|AUDIO_BASE_URL)=" ~/yuha-spark/.env')
KEY=$(sed -n 's/^YUHA_API_KEY=//p' <<<"$REMOTE")
BASE=$(sed -n 's/^AUDIO_BASE_URL=//p' <<<"$REMOTE")
HOST=$(sed -E 's#^https?://([^:/]+).*#\1#' <<<"$BASE")
[[ -n "$KEY" && -n "$BASE" ]] || { echo "could not read key/base url from dgx:~/yuha-spark/.env"; exit 1; }

cat >> "$ENV_FILE" <<BLOCK

$BEGIN
# Self-hosted ACE-Step 3.5B on the DGX Spark (LAN). Development only.
MUSIC_ADAPTER=http
MUSIC_PROVIDER_ID=ace-step-spark
MUSIC_BASE_URL=$BASE
MUSIC_API_KEY=$KEY
MUSIC_MODEL=ace-step
# No signed agreement exists for a self-hosted model; these are dev labels, not contracts.
MUSIC_CONTRACT_VERSION=selfhosted-dev
MUSIC_LICENSE_VERSION=selfhosted-dev
MUSIC_SUBMIT_PATH=/v1/jobs
MUSIC_POLL_PATH=/v1/jobs/{id}
MUSIC_REQUEST_ID_FIELD=id
MUSIC_STATUS_FIELD=status
MUSIC_AUDIO_URL_FIELD=audio_url
MUSIC_STATUS_MAP={"pending":["queued","running"],"completed":["succeeded"],"failed":["failed"],"rejected":["rejected"]}
MUSIC_IDEMPOTENCY_HEADER=Idempotency-Key
# hostname only — fetch-audio.ts compares url.hostname, the port is not part of it
MUSIC_ALLOWED_AUDIO_HOSTS=$HOST
MUSIC_ALLOW_INSECURE_SELF_HOSTED=true
MUSIC_SUPPORTS_INSTRUMENTAL=true
MUSIC_SUPPORTS_CANCEL=false
MUSIC_SUPPORTS_WEBHOOK=false
MUSIC_SUPPORTS_STATUS_QUERY=true
MUSIC_COMMERCIAL_DELIVERY=false
# the Spark generates one song at a time; extra jobs queue there (8 max, then 429)
MUSIC_MAX_CONCURRENCY=1
MUSIC_DATA_REGION=self-hosted-lan-jp
# Lyric sync: the Spark service aligns lyrics to the vocal with Whisper.
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
echo "wired: MUSIC_BASE_URL=$BASE  MUSIC_ALLOWED_AUDIO_HOSTS=$HOST  (backup: $(ls -t $ENV_FILE.bak-* | head -1))"
