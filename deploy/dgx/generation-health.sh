#!/usr/bin/env bash
# Read-only aggregate diagnostics; no prompts, lyrics, users, job ids or secrets.
# Run from a machine that can reach the configured DGX SSH host:
#   DGX=your-ssh-host bash deploy/dgx/generation-health.sh
set -euo pipefail
DGX="${DGX:-dgx}"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$DGX" \
  'cd ~/yuha-app && docker compose exec -T mysql sh -c '\''exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" --batch loopscene_dev'\''' <<'SQL'
SELECT 'finished jobs, rolling 7 days; excludes queued/running/cancelled' AS metric;
SELECT state, COUNT(*) AS jobs FROM generation_jobs
 WHERE state IN ('DELIVERED','FAILED','REJECTED')
 AND finished_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 7 DAY) GROUP BY state;
SELECT ROUND(100 * SUM(state = 'DELIVERED') / NULLIF(COUNT(*), 0), 2) AS success_pct,
 COUNT(*) AS finished_sample FROM generation_jobs
 WHERE state IN ('DELIVERED','FAILED','REJECTED')
 AND finished_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 7 DAY);
SELECT 'failure categories, rolling 7 days' AS metric;
SELECT provider_id, state, error_code, COUNT(*) AS jobs FROM generation_jobs
 WHERE state IN ('FAILED','REJECTED')
 AND finished_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 7 DAY)
 GROUP BY provider_id, state, error_code ORDER BY jobs DESC;
SELECT 'request duration and vocals, finished jobs, rolling 7 days' AS metric;
SELECT JSON_EXTRACT(input, '$.durationSeconds') AS duration_seconds,
 JSON_EXTRACT(input, '$.instrumental') AS instrumental, state, COUNT(*) AS jobs
 FROM generation_jobs WHERE state IN ('DELIVERED','FAILED','REJECTED')
 AND finished_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 7 DAY)
 GROUP BY duration_seconds, instrumental, state ORDER BY duration_seconds, instrumental, state;
SELECT 'current unfinished jobs; age is not generation duration' AS metric;
SELECT provider_id, state, COUNT(*) AS jobs,
 MAX(TIMESTAMPDIFF(SECOND, created_at, UTC_TIMESTAMP(3))) AS oldest_age_seconds
 FROM generation_jobs WHERE state NOT IN ('DELIVERED','FAILED','REJECTED','CANCELLED')
 GROUP BY provider_id, state;
SELECT 'provider attempt failures, rolling 7 days' AS metric;
SELECT provider_id, status, error_code, COUNT(*) AS attempts
 FROM generation_attempts WHERE started_at >= DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 7 DAY)
 GROUP BY provider_id, status, error_code ORDER BY attempts DESC;
SQL
