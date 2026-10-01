import type { AppContext } from '@yuha/api';
import {
  processWebhookEvent,
  recoverUngrantedOrders,
  reconcilePendingCheckouts,
  reconcileUngrantedSubscriptions,
  sweepExpiredTrackAudio,
} from '@yuha/api';
import {
  claimJob,
  claimJobById,
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
          /*
           * Claim the job this message names, or do nothing.
           *
           * This used to call `claimJob`, which ignores the id and takes the
           * oldest unleased job, and then fell back to `runJobStep(jobId)` when
           * the claim came back empty — stepping a job **nobody held the lease
           * on**. `submitJob` calls the text model and the music provider
           * before its first state transition, so two workers in that window
           * both pay for a generation and only one of them can win the
           * transition. `claimJobById` has existed for this since the lease was
           * written and had no callers.
           *
           * An empty claim now means somebody else holds it or it is already
           * terminal. Either way this message has nothing to do: the lease
           * holder will finish it, and `pollingLoop` picks up anything stalled.
           */
          const claimed = await withTx(async (tx) =>
            claimJobById({ jobId, owner, leaseSeconds: visibility }, tx),
          );
          if (!claimed) {
            await ctx.queue.deleteMessage(msg.receiptHandle);
            continue;
          }
          await runJobStep(deps, claimed.id);
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

  /*
   * One try per sweep, not one try around all of them.
   *
   * These eight ran inside a single `try` in sequence, so a throw anywhere
   * skipped everything after it — and skipped it again every minute, because
   * the input that threw was still there on the next pass. The reachable
   * version of that is not hypothetical: `reconcilePendingCheckouts` calls
   * `handleCheckoutCompleted`, which throws by design when a charge disagrees
   * with the catalogue, and its query is `ORDER BY created_at`, so one order
   * at the front of the queue silenced the subscription recovery sweep, the
   * retention sweep and the ledger reconciliation for good. Nothing would
   * have said so either: the catch logged `maintenance loop error` without
   * naming the step, and the three alarms that depend on those sweeps read
   * the only thing they could, which is zero.
   */
  const step = async (name: string, run: () => Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (err) {
      log('error', 'maintenance step failed', { step: name, err: (err as Error).message });
    }
  };

  while (!deps.stopped()) {
    await step('expire-batches', async () => {
      const expired = await expireBatches();
      if (expired) log('info', 'expired entitlement batches', { count: expired });
    });

    await step('stale-unknown-jobs', async () => {
      const stale = await listStaleUnknownJobs(ctx.config.JOB_VERIFY_DEADLINE_SECONDS);
      for (const job of stale) {
        // Per job as well: one job whose compensation fails must not leave the
        // rest of the batch stuck in UNKNOWN until someone notices.
        try {
          await failStaleUnknownJob(ctx, job, log);
        } catch (err) {
          log('error', 'could not time out stale job', { jobId: job.id, err: (err as Error).message });
        }
      }
    });

    await step('recover-ungranted-orders', async () => {
      const recovered = await recoverUngrantedOrders(ctx);
      if (recovered) log('warn', 'recovered paid orders with missing entitlements', { count: recovered });
    });

    /*
     * Orders the provider settled and never told us about. The sweep above
     * cannot see these — it starts from `status = 'paid'`, which an order
     * only reaches because an event said so, and the missing thing here is
     * the event. Ten minutes is well past a normal delivery (seconds) and
     * well inside Stripe's own retry window, so a webhook that is merely
     * slow is never raced.
     *
     * Logged at `warn` even on success: settling by sweep means a delivery
     * was lost, and a silent repair would hide that the endpoint is broken.
     */
    await step('reconcile-pending-checkouts', async () => {
      const reconciled = await reconcilePendingCheckouts(ctx, 600);
      if (reconciled) {
        log('warn', 'settled paid checkouts whose webhook never arrived', { count: reconciled });
      }
    });

    /*
     * Subscribers settled by the sweep above, or by a checkout webhook, still
     * have nothing: their credits come from `invoice.paid`, and the sweep
     * above cannot grant them (PAY-06). Neither could anything else — the
     * PAY-11 sweep skips every product that is not one_time — so a lost
     * invoice meant a subscriber paid monthly and received nothing, forever.
     *
     * `warn` for the same reason as above: reaching this means a delivery was
     * lost, and repairing it quietly would hide that.
     */
    await step('reconcile-ungranted-subscriptions', async () => {
      const subscriptions = await reconcileUngrantedSubscriptions(ctx);
      if (subscriptions) {
        log('warn', 'granted subscription periods whose invoice never arrived', { count: subscriptions });
      }
    });

    /*
     * Audio of songs their owners deleted more than TRACK_RETENTION_DAYS ago.
     *
     * `info`, not `warn`: unlike the two sweeps above, reaching this is not
     * the symptom of anything. It is the retention promise being kept on
     * schedule, and a warning would teach whoever reads these logs to ignore
     * the word.
     */
    await step('retention-sweep', async () => {
      const purged = await sweepExpiredTrackAudio(ctx, {
        log: { error: (obj, msg) => log('error', msg, obj as Record<string, unknown>) },
      });
      if (purged.removed || purged.failed) {
        log('info', 'removed audio past the retention window', purged as unknown as Record<string, unknown>);
      }
    });

    await step('reconcile-balances', async () => {
      const drift = await reconcileBalances();
      if (drift.length) {
        // Never auto-corrected: a discrepancy is a bug to investigate, and
        // silently "fixing" it would destroy the evidence.
        log('error', 'ledger reconciliation found discrepancies', {
          count: drift.length,
          batches: drift.slice(0, 5).map((d) => d.batch_id),
        });
      }
    });

    await sleep(intervalMs);
  }
}
