import type { AppContext } from '@yuha/api';
import { failJob } from '@yuha/api';
import { recordCostEvent, type JobRow } from '@yuha/db';

type Log = (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;

/**
 * Times out a job that has sat in UNKNOWN past the verification deadline
 * (§12.3: 15 minutes — a job must never display "generating" forever).
 *
 * The user is made whole first, and the platform absorbs the upstream
 * reconciliation. GEN-09 then guarantees that if the result does eventually
 * arrive, it does not silently re-charge them.
 */
export async function failStaleUnknownJob(ctx: AppContext, job: JobRow, log: Log): Promise<void> {
  return timeOutJob(ctx, job, log, {
    errorCode: 'verification_timeout',
    errorDetail: `no confirmed upstream result within ${ctx.config.JOB_VERIFY_DEADLINE_SECONDS}s`,
    note: 'job timed out in verification; reservation released',
  });
}

/**
 * Times out a job the provider accepted and never finished.
 *
 * There was no deadline on SUBMITTED or PROCESSING at all. `pollJob` returns
 * on `pending` without touching the row, SUBMITTED has no transition to
 * CANCELLED so `cancelGeneration` answers `already_submitted_to_provider`,
 * and the only sweeper covers UNKNOWN — so a provider that accepted a request
 * and lost it held the user's credit and kept the job non-terminal for good.
 *
 * `assertConcurrencyLimit` counts every non-terminal job against
 * MAX_CONCURRENT_JOBS_PER_USER, which is 2, so two abandoned jobs ended that
 * account's ability to generate anything for the rest of its life — and
 * because `expireBatches` skips a batch holding a reservation, the other
 * credits in the pack never expired either. Neither the user nor an operator
 * had any way out.
 *
 * Same treatment as the verification timeout: the user is made whole first and
 * the platform absorbs the upstream cost, with GEN-09 covering a result that
 * arrives after the fact.
 */
export async function failAbandonedJob(ctx: AppContext, job: JobRow, log: Log): Promise<void> {
  return timeOutJob(ctx, job, log, {
    errorCode: 'upstream_abandoned',
    errorDetail:
      `provider accepted the request and reported no result within ` +
      `${ctx.config.JOB_UPSTREAM_DEADLINE_SECONDS}s`,
    note: 'job abandoned upstream; reservation released',
  });
}

async function timeOutJob(
  ctx: AppContext,
  job: JobRow,
  log: Log,
  what: { errorCode: string; errorDetail: string; note: string },
): Promise<void> {
  const caps = ctx.music.capabilities();

  // One last verification attempt before giving up, if the provider supports it.
  if (caps.supportsStatusQuery) {
    try {
      const result = await ctx.music.poll({ requestKey: job.provider_request_key });
      if (result.status === 'pending') {
        log('warn', 'job still pending upstream past its deadline', { jobId: job.id });
      }
    } catch {
      /* the timeout path below applies either way */
    }
  }

  const failed = await failJob(ctx, {
    job,
    to: 'FAILED',
    errorCode: what.errorCode,
    errorDetail: what.errorDetail,
  });
  if (!failed) return;

  // The upstream may still have run and may still bill us. Record that as a
  // cost the platform carries — it is not charged to the user.
  await recordCostEvent({
    jobId: job.id,
    providerId: caps.providerId,
    providerKind: 'music',
    eventType: 'failure',
    billable: caps.billFailedRequests,
    costMinor: caps.billFailedRequests ? caps.costPerRequestMinor : 0,
    isEstimate: caps.costIsEstimate,
    contractVersion: caps.contractVersion,
  });

  // `failJob` already released the reservation, so the user is whole — a
  // compensation batch on top of that would refund the same credit twice. The
  // `release` entry it wrote is what a late result later checks against
  // (GEN-09), so no extra bookkeeping is needed here.
  log('warn', what.note, { jobId: job.id });
}
