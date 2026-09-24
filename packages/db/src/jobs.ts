import type { PoolConnection } from 'mysql2/promise';
import { canTransition, type JobState } from '@yuha/contracts';
import { execute, newId, query, queryOne, toJson } from './pool.js';

export interface JobRow {
  id: string;
  user_id: string;
  project_id: string;
  idempotency_key: string;
  request_hash: string;
  state: JobState;
  input: Record<string, unknown>;
  resolved_params: Record<string, unknown> | null;
  provider_id: string | null;
  provider_model: string | null;
  provider_contract_version: string | null;
  provider_request_key: string;
  attempt_count: number;
  version: number;
  lease_owner: string | null;
  lease_expires_at: Date | null;
  cancel_requested_at: Date | null;
  track_id: string | null;
  error_code: string | null;
  error_detail: string | null;
  queued_at: Date | null;
  submitted_at: Date | null;
  delivered_at: Date | null;
  finished_at: Date | null;
  verify_started_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

const JOB_COLUMNS = `
  id, user_id, project_id, idempotency_key, request_hash, state, input, resolved_params,
  provider_id, provider_model, provider_contract_version, provider_request_key,
  attempt_count, version, lease_owner, lease_expires_at, cancel_requested_at,
  track_id, error_code, error_detail, queued_at, submitted_at, delivered_at,
  finished_at, verify_started_at, created_at, updated_at
`;

export async function getJob(id: string, tx?: PoolConnection): Promise<JobRow | undefined> {
  return queryOne<JobRow>(`SELECT ${JOB_COLUMNS} FROM generation_jobs WHERE id = ?`, [id], tx);
}

/** Ownership is part of the query, not a separate check a caller might skip (SEC-01). */
export async function getJobForUser(
  id: string,
  userId: string,
  tx?: PoolConnection,
): Promise<JobRow | undefined> {
  return queryOne<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM generation_jobs WHERE id = ? AND user_id = ?`,
    [id, userId],
    tx,
  );
}

export async function getJobByIdempotencyKey(
  userId: string,
  key: string,
  tx?: PoolConnection,
): Promise<JobRow | undefined> {
  return queryOne<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM generation_jobs WHERE user_id = ? AND idempotency_key = ?`,
    [userId, key],
    tx,
  );
}

export interface InsertJobInput {
  userId: string;
  projectId: string;
  idempotencyKey: string;
  requestHash: string;
  providerRequestKey: string;
  input: Record<string, unknown>;
  state?: JobState;
}

export async function insertJob(input: InsertJobInput, tx: PoolConnection): Promise<JobRow> {
  const id = newId();
  await execute(
    `INSERT INTO generation_jobs
       (id, user_id, project_id, idempotency_key, request_hash, provider_request_key, input, state)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.userId,
      input.projectId,
      input.idempotencyKey,
      input.requestHash,
      input.providerRequestKey,
      toJson(input.input),
      input.state ?? 'VALIDATING',
    ],
    tx,
  );
  return (await getJob(id, tx))!;
}

export async function setProviderRequestKey(
  jobId: string,
  key: string,
  tx: PoolConnection,
): Promise<void> {
  await execute(`UPDATE generation_jobs SET provider_request_key = ? WHERE id = ?`, [key, jobId], tx);
}

export async function setJobTrack(jobId: string, trackId: string, tx: PoolConnection): Promise<void> {
  await execute(`UPDATE generation_jobs SET track_id = ? WHERE id = ?`, [trackId, jobId], tx);
}

export interface TransitionPatch {
  providerId?: string | null;
  providerModel?: string | null;
  providerContractVersion?: string | null;
  resolvedParams?: Record<string, unknown> | null;
  trackId?: string | null;
  errorCode?: string | null;
  errorDetail?: string | null;
  clearLease?: boolean;
}

/**
 * Moves a job to a new state under optimistic concurrency.
 *
 * Returns undefined when the expected version no longer matches, i.e. another
 * worker or a webhook already advanced the job. Callers treat that as "someone
 * else won" and stop — this is how GEN-05 (worker dies mid-call), GEN-08
 * (duplicate success callback) and GEN-12 (cancel racing submit) converge
 * without either side double-charging.
 */
export async function transitionJob(
  params: {
    jobId: string;
    expectedVersion: number;
    from: JobState;
    to: JobState;
    patch?: TransitionPatch;
  },
  tx: PoolConnection,
): Promise<JobRow | undefined> {
  if (params.from !== params.to && !canTransition(params.from, params.to)) {
    throw new Error(`illegal job transition ${params.from} -> ${params.to}`);
  }
  const p = params.patch ?? {};
  const res = await execute(
    `UPDATE generation_jobs SET
        state = ?,
        version = version + 1,
        provider_id = COALESCE(?, provider_id),
        provider_model = COALESCE(?, provider_model),
        provider_contract_version = COALESCE(?, provider_contract_version),
        resolved_params = COALESCE(CAST(? AS JSON), resolved_params),
        track_id = COALESCE(?, track_id),
        error_code = ?,
        error_detail = ?,
        lease_owner = CASE WHEN ? THEN NULL ELSE lease_owner END,
        lease_expires_at = CASE WHEN ? THEN NULL ELSE lease_expires_at END,
        queued_at    = CASE WHEN ? = 'QUEUED'    AND queued_at    IS NULL THEN UTC_TIMESTAMP(3) ELSE queued_at END,
        submitted_at = CASE WHEN ? = 'SUBMITTED' AND submitted_at IS NULL THEN UTC_TIMESTAMP(3) ELSE submitted_at END,
        verify_started_at = CASE WHEN ? = 'UNKNOWN' AND verify_started_at IS NULL THEN UTC_TIMESTAMP(3) ELSE verify_started_at END,
        delivered_at = CASE WHEN ? = 'DELIVERED' AND delivered_at IS NULL THEN UTC_TIMESTAMP(3) ELSE delivered_at END,
        finished_at  = CASE WHEN ? IN ('DELIVERED','FAILED','REJECTED','CANCELLED') AND finished_at IS NULL
                            THEN UTC_TIMESTAMP(3) ELSE finished_at END,
        updated_at = UTC_TIMESTAMP(3)
      WHERE id = ? AND version = ? AND state = ?`,
    [
      params.to,
      p.providerId ?? null,
      p.providerModel ?? null,
      p.providerContractVersion ?? null,
      p.resolvedParams ? toJson(p.resolvedParams) : null,
      p.trackId ?? null,
      p.errorCode ?? null,
      p.errorDetail ?? null,
      p.clearLease ? 1 : 0,
      p.clearLease ? 1 : 0,
      params.to,
      params.to,
      params.to,
      params.to,
      params.to,
      params.jobId,
      params.expectedVersion,
      params.from,
    ],
    tx,
  );
  if (res.affectedRows === 0) return undefined;
  return getJob(params.jobId, tx);
}

/**
 * Claims one runnable job with a time-limited lease.
 *
 * SKIP LOCKED means two workers never take the same row; the lease means a
 * worker that dies (GEN-05) releases the job automatically once the lease
 * expires, without holding a database transaction open across the provider
 * call. Jobs in UNKNOWN are re-claimed too, but the worker will only *query*
 * the upstream for them, never resubmit blindly (GEN-06).
 */
export async function claimJob(
  params: { owner: string; leaseSeconds: number; states?: JobState[] },
  tx: PoolConnection,
): Promise<JobRow | undefined> {
  const states = params.states ?? (['QUEUED', 'SUBMITTED', 'UNKNOWN', 'PROCESSING'] as JobState[]);
  const placeholders = states.map(() => '?').join(', ');

  // MySQL cannot UPDATE a table it is selecting from in a subquery, so the
  // candidate is locked first and updated by id.
  const candidate = await queryOne<{ id: string }>(
    `SELECT id FROM generation_jobs
      WHERE state IN (${placeholders})
        AND (lease_expires_at IS NULL OR lease_expires_at < UTC_TIMESTAMP(3))
      ORDER BY created_at
      LIMIT 1
      FOR UPDATE SKIP LOCKED`,
    states,
    tx,
  );
  if (!candidate) return undefined;

  await execute(
    `UPDATE generation_jobs
        SET lease_owner = ?,
            lease_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND),
            updated_at = UTC_TIMESTAMP(3)
      WHERE id = ?`,
    [params.owner, params.leaseSeconds, candidate.id],
    tx,
  );
  return getJob(candidate.id, tx);
}

export async function claimJobById(
  params: { jobId: string; owner: string; leaseSeconds: number },
  tx: PoolConnection,
): Promise<JobRow | undefined> {
  const res = await execute(
    `UPDATE generation_jobs
        SET lease_owner = ?,
            lease_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND),
            updated_at = UTC_TIMESTAMP(3)
      WHERE id = ?
        AND state NOT IN ('DELIVERED','FAILED','REJECTED','CANCELLED')
        AND (lease_expires_at IS NULL OR lease_expires_at < UTC_TIMESTAMP(3) OR lease_owner = ?)`,
    [params.owner, params.leaseSeconds, params.jobId, params.owner],
    tx,
  );
  if (res.affectedRows === 0) return undefined;
  return getJob(params.jobId, tx);
}

export async function extendLease(
  params: { jobId: string; owner: string; leaseSeconds: number },
  tx?: PoolConnection,
): Promise<boolean> {
  const res = await execute(
    `UPDATE generation_jobs
        SET lease_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND)
      WHERE id = ? AND lease_owner = ?`,
    [params.leaseSeconds, params.jobId, params.owner],
    tx,
  );
  return res.affectedRows > 0;
}

export async function releaseLease(jobId: string, owner: string, tx?: PoolConnection): Promise<void> {
  await execute(
    `UPDATE generation_jobs SET lease_owner = NULL, lease_expires_at = NULL
      WHERE id = ? AND lease_owner = ?`,
    [jobId, owner],
    tx,
  );
}

/**
 * Marks the user's intent to cancel. Whether the cancel actually takes effect
 * is decided later by the worker under the version guard, so the UI never
 * claims success for a job that was already submitted upstream (GEN-12).
 */
export async function requestCancel(
  params: { jobId: string; userId: string },
  tx: PoolConnection,
): Promise<JobRow | undefined> {
  const res = await execute(
    `UPDATE generation_jobs
        SET cancel_requested_at = COALESCE(cancel_requested_at, UTC_TIMESTAMP(3)),
            updated_at = UTC_TIMESTAMP(3)
      WHERE id = ? AND user_id = ?
        AND state NOT IN ('DELIVERED','FAILED','REJECTED','CANCELLED')`,
    [params.jobId, params.userId],
    tx,
  );
  if (res.affectedRows === 0) return undefined;
  return getJobForUser(params.jobId, params.userId, tx);
}

export async function incrementAttempt(jobId: string, tx: PoolConnection): Promise<number> {
  await execute(
    `UPDATE generation_jobs SET attempt_count = attempt_count + 1, updated_at = UTC_TIMESTAMP(3)
      WHERE id = ?`,
    [jobId],
    tx,
  );
  const row = await queryOne<{ attempt_count: number }>(
    `SELECT attempt_count FROM generation_jobs WHERE id = ?`,
    [jobId],
    tx,
  );
  return row?.attempt_count ?? 0;
}

export interface AttemptRow {
  id: string;
  job_id: string;
  attempt_no: number;
  provider_id: string;
  provider_request_id: string | null;
  status: string;
  error_code: string | null;
  started_at: Date;
  finished_at: Date | null;
}

const ATTEMPT_COLUMNS = `
  id, job_id, attempt_no, provider_id, provider_request_id, status, error_code, started_at, finished_at
`;

export async function insertAttempt(
  params: {
    jobId: string;
    attemptNo: number;
    providerId: string;
    providerModel?: string | null;
    requestPayload: Record<string, unknown>;
  },
  tx: PoolConnection,
): Promise<AttemptRow> {
  const id = newId();
  await execute(
    `INSERT INTO generation_attempts
       (id, job_id, attempt_no, provider_id, provider_model, request_payload, status)
     VALUES (?, ?, ?, ?, ?, ?, 'started')`,
    [
      id,
      params.jobId,
      params.attemptNo,
      params.providerId,
      params.providerModel ?? null,
      toJson(params.requestPayload),
    ],
    tx,
  );
  return (await queryOne<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM generation_attempts WHERE id = ?`,
    [id],
    tx,
  ))!;
}

export async function updateAttempt(
  params: {
    attemptId: string;
    status: string;
    providerRequestId?: string | null;
    responsePayload?: Record<string, unknown> | null;
    errorCode?: string | null;
    finished?: boolean;
  },
  tx?: PoolConnection,
): Promise<void> {
  await execute(
    `UPDATE generation_attempts SET
        status = ?,
        provider_request_id = COALESCE(?, provider_request_id),
        response_payload = COALESCE(CAST(? AS JSON), response_payload),
        error_code = ?,
        finished_at = CASE WHEN ? THEN UTC_TIMESTAMP(3) ELSE finished_at END
      WHERE id = ?`,
    [
      params.status,
      params.providerRequestId ?? null,
      params.responsePayload ? toJson(params.responsePayload) : null,
      params.errorCode ?? null,
      params.finished ? 1 : 0,
      params.attemptId,
    ],
    tx,
  );
}

export async function latestAttempt(jobId: string, tx?: PoolConnection): Promise<AttemptRow | undefined> {
  return queryOne<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM generation_attempts
      WHERE job_id = ? ORDER BY attempt_no DESC LIMIT 1`,
    [jobId],
    tx,
  );
}

/** Unfinished jobs for one user, so the studio can restore state after a reload (GEN-10). */
export async function listOpenJobs(userId: string, limit = 20): Promise<JobRow[]> {
  return query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM generation_jobs
      WHERE user_id = ? AND state NOT IN ('DELIVERED','FAILED','REJECTED','CANCELLED')
      ORDER BY created_at DESC
      LIMIT ?`,
    [userId, limit],
  );
}

/** Jobs stuck in UNKNOWN past the verification window (§12.3: 15 minutes). */
export async function listStaleUnknownJobs(olderThanSeconds: number): Promise<JobRow[]> {
  return query<JobRow>(
    `SELECT ${JOB_COLUMNS} FROM generation_jobs
      WHERE state = 'UNKNOWN'
        AND verify_started_at IS NOT NULL
        AND verify_started_at < DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? SECOND)
      ORDER BY verify_started_at
      LIMIT 100`,
    [olderThanSeconds],
  );
}

export async function recordCostEvent(
  params: {
    jobId?: string | null;
    attemptId?: string | null;
    providerId: string;
    providerKind: 'music' | 'text';
    eventType: 'success' | 'failure' | 'rejected' | 'retry' | 'late_success' | 'cancelled';
    billable: boolean;
    costMinor: number;
    currency?: string;
    isEstimate: boolean;
    contractVersion?: string | null;
    usage?: Record<string, unknown>;
  },
  tx?: PoolConnection,
): Promise<void> {
  await execute(
    `INSERT INTO provider_cost_events
       (id, job_id, attempt_id, provider_id, provider_kind, event_type, billable,
        cost_minor, currency, is_estimate, contract_version, usage_data)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      newId(),
      params.jobId ?? null,
      params.attemptId ?? null,
      params.providerId,
      params.providerKind,
      params.eventType,
      params.billable ? 1 : 0,
      params.costMinor,
      params.currency ?? 'jpy',
      params.isEstimate ? 1 : 0,
      params.contractVersion ?? null,
      toJson(params.usage ?? {}),
    ],
    tx,
  );
}
