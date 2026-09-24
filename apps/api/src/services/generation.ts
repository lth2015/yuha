import { createHash } from 'node:crypto';
import {
  AppError,
  JOB_STATE_TO_PHASE,
  SONG_DURATIONS,
  type CreateGenerationRequest,
  type JobView,
} from '@yuha/contracts';
import {
  enqueueOutbox,
  getBalance,
  getJobByIdempotencyKey,
  getJobForUser,
  insertJob,
  insertProject,
  getProjectForUser,
  isUniqueViolation,
  lockUserEntitlements,
  query,
  releaseReservation,
  reporting,
  requestCancel,
  reserveUnit,
  setProviderRequestKey,
  trackEvent,
  transitionJob,
  withTx,
  withTxRetry,
  type JobRow,
} from '@yuha/db';
import { checkPrompt } from '@yuha/providers';
import type { AppContext } from '../context.js';

/**
 * Canonical hash of the request body. Two submissions under the same
 * idempotency key are "the same request" only if this matches — that is what
 * separates GEN-01 (replay, return the same job) from GEN-02 (different body,
 * return 409 and change nothing).
 */
export function hashRequest(userId: string, req: CreateGenerationRequest): string {
  const canonical = JSON.stringify({
    u: userId,
    m: req.mode,
    t: req.title ?? null,
    p: req.prompt,
    l: req.lyrics ?? null,
    s: req.styles,
    i: req.instrumental,
    e: Math.round(req.energy * 1000),
    d: req.durationSeconds,
    v: req.visibility,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function providerRequestKey(jobId: string): string {
  // Stable for the life of the job, so a retry after a timeout reaches the
  // upstream as the same request rather than a second billable one (GEN-06).
  return `sonare-${jobId}`;
}

export interface CreateGenerationResult {
  job: JobRow;
  deduplicated: boolean;
}

/**
 * Creates a generation job.
 *
 * Everything that must be atomic happens in ONE transaction: the job row, the
 * credit reservation and the outbox record. §6.1 and §4.2 both depend on this —
 * there is no window in which credits are reserved but no work was queued, nor
 * one in which work is queued without a reservation.
 */
export async function createGeneration(
  ctx: AppContext,
  params: {
    userId: string;
    idempotencyKey: string;
    request: CreateGenerationRequest;
  },
): Promise<CreateGenerationResult> {
  const features = await ctx.features();
  if (!features.generationEnabled) {
    throw new AppError('SERVICE_DISABLED', 'generation is temporarily paused by an operator');
  }

  const req = params.request;
  const caps = ctx.music.capabilities();

  // AI-05: reject what the configured provider cannot deliver, before any spend.
  if (!caps.supportedDurationsSeconds.includes(req.durationSeconds)) {
    throw new AppError(
      'UNSUPPORTED_CAPABILITY',
      `the configured music provider does not support ${req.durationSeconds}s output`,
    );
  }
  if (req.instrumental && !caps.supportsInstrumentalOnly) {
    throw new AppError(
      'UNSUPPORTED_CAPABILITY',
      'the configured music provider cannot guarantee instrumental-only output',
    );
  }
  if (!req.instrumental && !caps.supportsVocals) {
    throw new AppError(
      'UNSUPPORTED_CAPABILITY',
      'the configured music provider cannot sing lyrics; choose instrumental',
    );
  }

  // Input screening happens before any spend and before the text model sees it.
  // Lyrics are user text exactly like the description, so they pass the same
  // screening (artist names, existing lyrics, impersonation attempts).
  const safety = checkPrompt(req.prompt);
  if (!safety.allowed) {
    // A blocked prompt costs nothing: no reservation, no upstream call.
    throw new AppError('PROMPT_BLOCKED', `prompt rejected: ${safety.reason}`, {
      reason: safety.reason,
      hintKey: safety.hintKey,
      appealable: safety.appealable,
    });
  }
  if (req.lyrics) {
    const lyricsSafety = checkPrompt(req.lyrics);
    if (!lyricsSafety.allowed) {
      throw new AppError('PROMPT_BLOCKED', `lyrics rejected: ${lyricsSafety.reason}`, {
        reason: lyricsSafety.reason,
        hintKey: lyricsSafety.hintKey,
        appealable: lyricsSafety.appealable,
      });
    }
  }

  const requestHash = hashRequest(params.userId, req);

  // Fast path for an obvious replay, before opening a transaction.
  const prior = await getJobByIdempotencyKey(params.userId, params.idempotencyKey);
  if (prior) {
    if (prior.request_hash !== requestHash) {
      throw new AppError(
        'IDEMPOTENCY_KEY_REUSED',
        'this idempotency key was already used for a different request',
      );
    }
    return { job: prior, deduplicated: true };
  }

  await assertConcurrencyLimit(ctx, params.userId);
  await assertWithinDailyBudget(ctx);

  return withTxRetry(async (tx) => {
    // Take the per-user entitlement lock FIRST, before anything that touches
    // the users row — see the deadlock note in the ledger design (GEN-03).
    await lockUserEntitlements(params.userId, tx);

    // Re-check inside the transaction: two concurrent requests with the same
    // key race here, and the unique index decides the winner.
    const raced = await getJobByIdempotencyKey(params.userId, params.idempotencyKey, tx);
    if (raced) {
      if (raced.request_hash !== requestHash) {
        throw new AppError(
          'IDEMPOTENCY_KEY_REUSED',
          'this idempotency key was already used for a different request',
        );
      }
      return { job: raced, deduplicated: true };
    }

    const projectId = params.request.projectId
      ? (await getProjectForUser(params.request.projectId, params.userId, tx))?.id
      : undefined;
    if (params.request.projectId && !projectId) {
      throw new AppError('NOT_FOUND', 'project not found');
    }
    const project =
      projectId ??
      (
        await insertProject(
          {
            ownerId: params.userId,
            title: defaultProjectTitle(req),
            scene: sceneForRequest(req),
          },
          tx,
        )
      ).id;

    let job: JobRow;
    try {
      job = await insertJob(
        {
          userId: params.userId,
          projectId: project,
          idempotencyKey: params.idempotencyKey,
          requestHash,
          providerRequestKey: 'pending',
          input: {
            mode: req.mode,
            title: req.title ?? null,
            prompt: req.prompt,
            lyrics: req.lyrics ?? null,
            styles: req.styles,
            instrumental: req.instrumental,
            energy: req.energy,
            durationSeconds: req.durationSeconds,
            vocalMode: req.instrumental ? 'instrumental' : 'with_vocals',
            visibility: req.visibility,
          },
        },
        tx,
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Lost the race; the winner's row is authoritative.
        const winner = await getJobByIdempotencyKey(params.userId, params.idempotencyKey, tx);
        if (winner && winner.request_hash === requestHash) return { job: winner, deduplicated: true };
        throw new AppError('IDEMPOTENCY_KEY_REUSED', 'concurrent reuse of this idempotency key');
      }
      throw err;
    }

    await setProviderRequestKey(job.id, providerRequestKey(job.id), tx);

    // RESERVED: exactly one unit, from the batch expiring soonest.
    const reservation = await reserveUnit({ userId: params.userId, jobId: job.id }, tx);
    if (!reservation.ok) {
      // Rolling back leaves no job row at all, so a failed reservation cannot
      // leave a phantom job behind (GEN-03).
      throw new AppError('INSUFFICIENT_CREDITS', 'not enough generation credits');
    }

    const reserved = await transitionJob(
      { jobId: job.id, expectedVersion: job.version, from: 'VALIDATING', to: 'RESERVED' },
      tx,
    );
    if (!reserved) throw new AppError('CONFLICT', 'job state changed during creation');

    const queued = await transitionJob(
      {
        jobId: job.id,
        expectedVersion: reserved.version,
        from: 'RESERVED',
        to: 'QUEUED',
        patch: {
          providerId: caps.providerId,
          providerModel: caps.model,
          providerContractVersion: caps.contractVersion,
        },
      },
      tx,
    );
    if (!queued) throw new AppError('CONFLICT', 'job state changed during creation');

    // Same transaction as the reservation — this is the outbox guarantee.
    await enqueueOutbox(
      {
        aggregateType: 'generation_job',
        aggregateId: job.id,
        eventType: 'generation.requested',
        payload: { jobId: job.id, userId: params.userId },
      },
      tx,
    );

    await trackEvent(
      {
        name: 'generation_submitted',
        userRef: params.userId,
        props: {
          mode: req.mode,
          instrumental: req.instrumental,
          durationSeconds: req.durationSeconds,
          provider: caps.providerId,
        },
        runMode: ctx.config.mode,
        isInternal: ctx.config.isDemo,
      },
      tx,
    );

    return { job: queued, deduplicated: false };
  });
}

function sceneForRequest(req: CreateGenerationRequest): string {
  const hay = `${req.styles.join(' ')} ${req.prompt}`.toLowerCase();
  if (/(lofi|lo-fi|chill|ambient|night|jazz)/.test(hay)) return 'night_walk';
  if (/(trap|hip.?hop|edm|house|techno|club|fashion)/.test(hay)) return 'outfit';
  if (/(synthwave|arcade|game|epic|battle|rock|metal|8.?bit)/.test(hay)) return 'gaming';
  return 'daily_log';
}

function defaultProjectTitle(req: CreateGenerationRequest): string {
  const first = req.styles[0];
  const now = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return `${first ? first.replace(/\b\w/g, (c) => c.toUpperCase()) + ' ' : ''}Sessions · ${now}`;
}

/** Per-user concurrency cap, enforced before any reservation. */
async function assertConcurrencyLimit(ctx: AppContext, userId: string): Promise<void> {
  const rows = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM generation_jobs
      WHERE user_id = ? AND state NOT IN ('DELIVERED','FAILED','REJECTED','CANCELLED')`,
    [userId],
  );
  const open = Number(rows[0]?.n ?? 0);
  if (open >= ctx.config.MAX_CONCURRENT_JOBS_PER_USER) {
    throw new AppError(
      'RATE_LIMITED',
      `at most ${ctx.config.MAX_CONCURRENT_JOBS_PER_USER} generations may run at once`,
    );
  }
}

/**
 * Daily upstream spend cap. When the cap is reached, new generation stops but
 * order lookup, the library and existing downloads keep working. Checked
 * before any reservation, so hitting the cap costs the user nothing.
 */
async function assertWithinDailyBudget(ctx: AppContext): Promise<void> {
  const cap = ctx.config.DAILY_BUDGET_MINOR;
  if (cap <= 0) return;

  const spent = await reporting.billableSpendSince(24);
  if (spent >= cap) {
    throw new AppError(
      'BUDGET_EXCEEDED',
      `daily upstream budget reached (${spent}/${cap} in the last 24h)`,
    );
  }
}

/**
 * Estimated wait, expressed as a range. UI-04 forbids a fabricated precise
 * percentage; longer songs honestly take longer.
 */
export function estimateFor(ctx: AppContext, job: JobRow): JobView['estimate'] {
  const startedAt = (job.queued_at ?? job.created_at).getTime();
  const elapsed = (Date.now() - startedAt) / 1000;
  const delayed = elapsed > ctx.config.JOB_DELAY_WARNING_SECONDS;
  if (['DELIVERED', 'FAILED', 'REJECTED', 'CANCELLED'].includes(job.state)) {
    return { minSeconds: 0, maxSeconds: 0, delayed: false };
  }
  const input = job.input as { durationSeconds?: number };
  const d = input.durationSeconds ?? 120;
  const scale = SONG_DURATIONS.includes(d as (typeof SONG_DURATIONS)[number]) ? d / 120 : 1;
  return {
    minSeconds: Math.round(30 * Math.min(scale, 2)),
    maxSeconds: Math.round(120 * Math.min(scale, 2)),
    delayed,
  };
}

export function toJobView(ctx: AppContext, job: JobRow): JobView {
  const input = job.input as {
    mode?: 'simple' | 'custom';
    title?: string | null;
    prompt?: string;
    styles?: string[];
    instrumental?: boolean;
    energy?: number;
    durationSeconds?: number;
    visibility?: 'private' | 'public';
  };
  return {
    jobId: job.id,
    projectId: job.project_id,
    state: job.state,
    phase: JOB_STATE_TO_PHASE[job.state],
    mode: input.mode ?? 'simple',
    title: input.title ?? null,
    prompt: input.prompt ?? '',
    styles: input.styles ?? [],
    instrumental: input.instrumental ?? true,
    energy: input.energy ?? 0.5,
    durationSeconds: input.durationSeconds ?? 30,
    visibility: input.visibility ?? 'private',
    trackId: job.track_id,
    errorCode: job.error_code,
    estimate: estimateFor(ctx, job),
    createdAt: job.created_at.toISOString(),
    updatedAt: job.updated_at.toISOString(),
    demo: ctx.config.isDemo,
  };
}

export async function getJobView(ctx: AppContext, jobId: string, userId: string): Promise<JobView> {
  const job = await getJobForUser(jobId, userId);
  if (!job) throw new AppError('NOT_FOUND', 'job not found');
  return toJobView(ctx, job);
}

/**
 * Requests cancellation.
 *
 * GEN-12: this only records the intent. Whether the job actually cancels is
 * decided by the worker under the version guard, so the response never claims
 * "cancelled" for something already submitted upstream.
 */
export async function cancelGeneration(
  ctx: AppContext,
  params: { jobId: string; userId: string },
): Promise<{ jobId: string; state: JobRow['state']; cancelled: boolean; reason: string | null }> {
  const job = await getJobForUser(params.jobId, params.userId);
  if (!job) throw new AppError('NOT_FOUND', 'job not found');

  if (job.state === 'CANCELLED') {
    return { jobId: job.id, state: 'CANCELLED', cancelled: true, reason: null };
  }
  if (['DELIVERED', 'FAILED', 'REJECTED'].includes(job.state)) {
    throw new AppError('JOB_NOT_CANCELLABLE', `job is already ${job.state}`);
  }

  return withTx(async (tx) => {
    const marked = await requestCancel({ jobId: params.jobId, userId: params.userId }, tx);
    if (!marked) {
      const current = await getJobForUser(params.jobId, params.userId, tx);
      throw new AppError('JOB_NOT_CANCELLABLE', `job is already ${current?.state ?? 'finished'}`);
    }

    // Only a job that has NOT reached the provider can be cancelled here and
    // now. Anything already submitted keeps running and stays chargeable-or-not
    // according to its real outcome.
    if (marked.state === 'QUEUED' || marked.state === 'RESERVED') {
      const cancelled = await transitionJob(
        {
          jobId: marked.id,
          expectedVersion: marked.version,
          from: marked.state,
          to: 'CANCELLED',
          patch: { errorCode: 'cancelled_by_user', clearLease: true },
        },
        tx,
      );
      if (cancelled) {
        await releaseReservation(
          { userId: params.userId, jobId: marked.id, reason: 'cancelled_by_user' },
          tx,
        );
        return { jobId: marked.id, state: 'CANCELLED' as const, cancelled: true, reason: null };
      }
    }

    const current = (await getJobForUser(params.jobId, params.userId, tx))!;
    return {
      jobId: current.id,
      state: current.state,
      cancelled: false,
      reason: 'already_submitted_to_provider',
    };
  });
}

export async function currentBalance(userId: string): Promise<{ available: number; reserved: number }> {
  const b = await getBalance(userId);
  return { available: b.available, reserved: b.reserved };
}
