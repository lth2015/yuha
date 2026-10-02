#!/usr/bin/env bash
# Why did a generation fail? Takes the job id, or just the few characters the
# failure screen prints under the waveform.
#
#     cd deploy/dgx && ./why-failed.sh a45d2bd8
#
# Read-only: it queries and reads logs, and changes nothing. Run it BEFORE any
# redeploy — `docker compose up --build` recreates containers and their logs
# go with them, which is how the last cause of this went unexplained.
set -euo pipefail
cd "$(dirname "$0")"
DGX="${DGX:-dgx}"
AR='~/yuha-app'
MR='~/yuha-spark'
ID="${1:-}"
[[ -n "$ID" ]] || { echo "usage: ./why-failed.sh <job-id-or-prefix>" >&2; exit 1; }

# SQL over stdin, so its quotes never meet the shell quoting of ssh + sh -c.
# Same approach as deploy_yuha.sh, for the same reason.
SQL() {
  printf '%s\n' "$1" | ssh "$DGX" \
    "cd $AR && docker compose exec -T mysql sh -c 'mysql -uroot -p\"\$MYSQL_ROOT_PASSWORD\" loopscene_dev' 2>&1 | grep -v 'Using a password'"
}

echo "== the job"
# No `phase` column: the phase a client sees is derived from the state
# (JOB_STATE_TO_PHASE), not stored. The timestamps below say how far it got —
# queued_at set but submitted_at null means it never reached the provider.
SQL "SELECT id, state, error_code, error_detail, provider_id, attempt_count,
            JSON_EXTRACT(input,'\$.durationSeconds') AS dur,
            JSON_EXTRACT(input,'\$.voice')           AS voice,
            JSON_EXTRACT(input,'\$.instrumental')    AS instrumental,
            CHAR_LENGTH(JSON_UNQUOTE(JSON_EXTRACT(input,'\$.lyrics'))) AS lyric_chars,
            resolved_params IS NOT NULL AS has_intent,
            created_at, queued_at, submitted_at, delivered_at, finished_at
       FROM generation_jobs WHERE id LIKE '${ID}%'\\G"

echo "== what the provider said, attempt by attempt"
SQL "SELECT a.attempt_no, a.provider_id, a.status, a.error_code, a.provider_request_id,
            a.started_at, a.finished_at, LEFT(a.response_payload, 400) AS response
       FROM generation_attempts a JOIN generation_jobs j ON j.id = a.job_id
      WHERE j.id LIKE '${ID}%' ORDER BY a.attempt_no\\G"

echo "== the intent the text model produced (null here means it never got that far)"
SQL "SELECT JSON_PRETTY(resolved_params) AS intent FROM generation_jobs WHERE id LIKE '${ID}%'\\G"

# `upstream_unreachable` means the worker's fetch threw before any reply — not
# a timeout, which is reported separately. The question it raises is always
# the same one, so ask it here rather than leaving it to the decode table:
# can the worker, from inside its own container, reach the URL it was
# configured with? This is the same fetch, the same env var and the same
# network namespace the provider uses, so its answer is the provider's answer.
echo "== can the worker reach the music service?"
ssh "$DGX" "cd $AR && grep -E '^MUSIC_(ADAPTER|BASE_URL|SUBMIT_PATH)=' app.env" 2>/dev/null || true
ssh "$DGX" "cd $AR && docker compose exec -T worker node -" <<'PROBE' || echo "   (the worker container is not running — that alone would do it)"
const u = process.env.MUSIC_BASE_URL;
if (!u) { console.log('   MUSIC_BASE_URL is not set in the worker'); process.exit(0); }
console.log('   worker sees MUSIC_BASE_URL =', u);
fetch(new URL('/healthz', u), { signal: AbortSignal.timeout(8000) })
  .then((r) => r.text())
  .then((t) => console.log('   reachable:', t.slice(0, 200)))
  .catch((e) => console.log('   UNREACHABLE:', e.name, e.message, e.cause?.code ?? ''));
PROBE

echo "== worker and api lines mentioning this job"
ssh "$DGX" "cd $AR && docker compose logs --no-color --tail 4000 worker api 2>/dev/null | grep -i '${ID}' | tail -40" || true

echo "== the last of the worker log, in case the failure never named the job"
ssh "$DGX" "cd $AR && docker compose logs --no-color --tail 60 worker" || true

echo "== the music service"
ssh "$DGX" "cd $MR && docker compose logs --no-color --tail 40 music" || true

cat <<'DECODE'

== what the error_code means, and where to look next

  text_model_refused     TokenStars declined the content itself. State is
                         REJECTED, not FAILED. Not a bug.
  text_model_failed      The text model call failed, timed out, or came back
                         unparseable. Look at the api log, not the music box.
  intent_schema_invalid  The model's JSON did not fit `musicIntent`. This is
                         the one to suspect after a contract change — the
                         intent gained a `voice` field today.
  upstream_rejected      The music service refused the request (422). Its own
                         log says why; `error_detail` carries its code.
  upstream_failed        The music service errored or was unreachable.
  upstream_no_record     We asked about a request it had never heard of.
                         Usually a restart mid-generation.
  missing_resolved_params  The job reached the music step with no intent.
  audio_fetch_failed     The render happened; pulling the file did not.
                         Check MUSIC_ALLOWED_AUDIO_HOSTS (SEC-05) — the host
                         the service hands back has to be on it.
  output_check_failed    Audio arrived and failed its check: length outside
                         the 750ms tolerance, or near-silent.
  cancelled_by_user      Somebody pressed cancel.

A FAILED job refunds its credit; a REJECTED one does too. "技术故障" on the
screen is FAILED. If the row above says REJECTED, the screen is telling the
wrong story and that is its own bug.
DECODE
