import type { AppContext } from '@yuha/api';
import { processWebhookEvent, recoverUngrantedOrders } from '@yuha/api';
import {
  claimJob,
  claimOutboxBatch,
  claimWebhookEvents,
  expireBatches,
  listStaleUnknownJobs,
  markDispatchFailed,
  markDispatched,
  reconcileBalances,
  withTx,
} from '@yuha/db';
import { runJobStep, type PipelineDeps } from './pipeline.js';
import { failStaleUnknownJob } from './reconcile.js';

export interface LoopDeps extends PipelineDeps {
  stopped: () => boolean;
}

export function makeLogger(component: string) {
  return (level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}) => {
    // Structured JSON so CloudWatch queries work; no prompts, no secrets.
    console.log(JSON.stringify({ level, component, msg, ts: new Date().toISOString(), ...fields }));
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Outbox dispatcher.
 *
 * Moves committed domain events onto the queue. §4.2: the outbox row was
 * written in the same transaction as the job, so a dispatch failure here only
 * delays work — it never loses a reservation. Repeated failures back off and
 * eventually mark the row failed for alerting.
 */
export async function outboxLoop(deps: LoopDeps): Promise<void> {
  const { ctx, log } = deps;
  while (!deps.stopped()) {
    let dispatched = 0;
    try {
      const rows = await withTx(async (tx) => claimOutboxBatch(20, tx));
      for (const row of rows) {
        try {
          await ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
          await markDispatched(row.id);
          dispatched += 1;
        } catch (err) {
          await markDispatchFailed({
            id: row.id,
            error: (err as Error).message,
            // Exponential-ish backoff, capped.
            retryInSeconds: Math.min(300, 2 ** Math.min(row.attempts, 8)),
            maxAttempts: 10,
          });
          log('error', 'outbox dispatch failed', { outboxId: row.id, err: (err as Error).message });
        }
      }
    } catch (err) {
      log('error', 'outbox loop error', { err: (err as Error).message });
    }
    await sleep(dispatched > 0 ? 100 : 1000);
  }
}

/**
 * Queue consumer.
 *
 * At-least-once delivery is assumed: a duplicate message re-enters
 * `runJobStep`, which is idempotent through the job version guard. The message
 * is deleted after the step completes; if the worker dies first, the message
 * becomes visible again and the job's lease expires, so it is retried.
 */
export async function generationLoop(deps: LoopDeps): Promise<void> {
  const { ctx, owner, log } = deps;
  const visibility = ctx.config.JOB_LEASE_SECONDS;

  while (!deps.stopped()) {
    try {
      const messages = await ctx.queue.receive({
        max: 5,
        visibilityTimeoutSeconds: visibility,
        waitSeconds: 5,
      });
      if (!messages.length) {
        await sleep(500);
        continue;
      }

      for (const msg of messages) {
        const jobId = typeof msg.body['jobId'] === 'string' ? msg.body['jobId'] : null;
        if (!jobId) {
          await ctx.queue.deleteMessage(msg.receiptHandle);
          continue;
        }
        try {
          const claimed = await withTx(async (tx) =>
            claimJob({ owner, leaseSeconds: visibility, states: ['QUEUED', 'SUBMITTED', 'UNKNOWN', 'PROCESSING'] }, tx),
          );
          // The claim may return a different job than the message named — that
          // is fine, work is work — but prefer the addressed one when free.
          const target = claimed?.id ?? jobId;
          await runJobStep(deps, target);
          await ctx.queue.deleteMessage(msg.receiptHandle);
        } catch (err) {
          log('error', 'job step failed', { jobId, err: (err as Error).message });
          if (msg.receiveCount >= 5) {
            // Retry cap: park it rather than looping forever on a persistent
            // upstream fault (§12.3).
            await ctx.queue.deadLetter(msg.receiptHandle, (err as Error).message);
          } else {
            await ctx.queue.changeVisibility(msg.receiptHandle, Math.min(300, 5 * 2 ** msg.receiveCount));
          }
        }
      }
    } catch (err) {
      log('error', 'generation loop error', { err: (err as Error).message });
      await sleep(2000);
    }
  }
}

/**
 * Sweeper for jobs whose queue message was lost, or which are in SUBMITTED /
 * UNKNOWN and need a status query. GEN-10 depends on this: a job always makes
 * progress from persisted state, even if nothing is left on the queue.
 */
export async function pollingLoop(deps: LoopDeps): Promise<void> {
  const { ctx, owner, log } = deps;
  while (!deps.stopped()) {
    try {
      const job = await withTx(async (tx) =>
        claimJob({ owner, leaseSeconds: ctx.config.JOB_LEASE_SECONDS }, tx),
      );
      if (!job) {
        await sleep(2000);
        continue;
      }
      await runJobStep(deps, job.id);
    } catch (err) {
      log('error', 'polling loop error', { err: (err as Error).message });
      await sleep(2000);
    }
  }
}

/**
 * Webhook processor.
 *
 * The HTTP handler only verifies and stores; the actual work happens here so a
 * slow grant cannot make Stripe time out and retry (§4.2/PAY-04).
 */
export async function webhookLoop(deps: LoopDeps): Promise<void> {
  const { ctx, log } = deps;
  while (!deps.stopped()) {
    let processed = 0;
    try {
      const events = await withTx(async (tx) => claimWebhookEvents(10, tx));
      for (const ev of events) {
        try {
          await processWebhookEvent(ctx, ev);
          processed += 1;
        } catch (err) {
          log('error', 'webhook processing failed', {
            eventId: ev.event_id,
            type: ev.event_type,
            err: (err as Error).message,
          });
        }
      }
    } catch (err) {
      log('error', 'webhook loop error', { err: (err as Error).message });
    }
    await sleep(processed > 0 ? 100 : 1000);
  }
}

/**
 * Periodic maintenance (§12.3):
 *   - expire credit batches past their validity;
 *   - time out jobs stuck in UNKNOWN and compensate the user;
 *   - recover paid orders whose entitlement never landed (PAY-11);
 *   - cross-check the ledger against its derived counters and alert on drift.
 */
export async function maintenanceLoop(deps: LoopDeps, intervalMs = 60_000): Promise<void> {
  const { ctx, log } = deps;
  while (!deps.stopped()) {
    try {
      const expired = await expireBatches();
      if (expired) log('info', 'expired entitlement batches', { count: expired });

      const stale = await listStaleUnknownJobs(ctx.config.JOB_VERIFY_DEADLINE_SECONDS);
      for (const job of stale) {
        await failStaleUnknownJob(ctx, job, log);
      }

      const recovered = await recoverUngrantedOrders(ctx);
      if (recovered) log('warn', 'recovered paid orders with missing entitlements', { count: recovered });

      const drift = await reconcileBalances();
      if (drift.length) {
        // Never auto-corrected: a discrepancy is a bug to investigate, and
        // silently "fixing" it would destroy the evidence.
        log('error', 'ledger reconciliation found discrepancies', {
          count: drift.length,
          batches: drift.slice(0, 5).map((d) => d.batch_id),
        });
      }
    } catch (err) {
      log('error', 'maintenance loop error', { err: (err as Error).message });
    }
    await sleep(intervalMs);
  }
}
