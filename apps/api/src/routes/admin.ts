import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, idempotencyKeySchema } from '@yuha/contracts';
import {
  compensateUnits,
  getUser,
  lockUser,
  unitsGrantedByActorSince,
  getAccountDeletion,
  getRightsCase,
  listAccountDeletions,
  listAuditLogs,
  listRightsCases,
  listSettings,
  markAccountDeletionVerified,
  query,
  reconcileBalances,
  reporting,
  setLicenseStatus,
  setSetting,
  setTrackState,
  updateRightsCase,
  withTx,
  withTxRetry,
  writeAuditLog,
} from '@yuha/db';
import type { AppContext } from '../context.js';
import { executeAccountDeletion } from '../services/deletion.js';
import { decideHeldOrder, heldOrderQueue } from '../services/order-review.js';
import { findCustomers, getCustomer, giftCredits } from '../services/operator-grant.js';

/**
 * Operations console API (UI-15).
 *
 * Two rules apply to every mutating route here:
 *   - permissions are separated: `support` can look and can compensate a user,
 *     but only `admin` can change licence status, feature switches or roles;
 *   - a `reason` is mandatory and is written to `audit_logs` together with the
 *     before/after state. The column is NOT NULL, so an unexplained privileged
 *     action cannot be recorded — and therefore cannot happen.
 */
export default async function adminRoutes(app: FastifyInstance, opts: { ctx: AppContext }) {
  const { ctx } = opts;
  const staff = app.requireRole(['support', 'admin']);
  const adminOnly = app.requireRole(['admin']);

  const reasoned = z.object({ reason: z.string().min(5).max(500) });
  /*
   * A shorter bound for the two routes whose reason also lands in
   * `ledger_entries.reason`, which is VARCHAR(255).
   *
   * `reasoned`'s 500 was set against `audit_logs.reason`, which is 500. The
   * credit paths prefix the text — `operator_gift: ` (15) and
   * `operator_compensation: ` (23) — so a 500-character reason produced 515
   * and 523 characters for a 255-byte column. Under STRICT_TRANS_TABLES that
   * is ER_DATA_TOO_LONG, which is not an `AppError`, so the operator got a
   * bare 500 INTERNAL_ERROR with nothing pointing at the reason field — and
   * then retried, which is what an idempotency key now absorbs. 200 leaves
   * room for both prefixes with margin.
   */
  const ledgerReasoned = z.object({ reason: z.string().min(5).max(200) });

  // ------------------------------------------------------------- overview

  app.get('/v1/admin/overview', { preHandler: staff }, async () => {
    const [ops, cost, revenue, funnel, discrepancies] = await Promise.all([
      reporting.operationsSnapshot(),
      reporting.costSummary(30),
      reporting.revenueSummary(30),
      reporting.funnelSummary(),
      reconcileBalances(),
    ]);
    return {
      mode: ctx.config.mode,
      operations: { ...ops, ledgerDiscrepancies: discrepancies.length },
      cost,
      revenue,
      funnel,
      // §11.2/§11.3: modelled numbers are labelled, and nothing here is
      // presented as validated commercial performance.
      disclaimer:
        ctx.config.isDemo
          ? 'demo mode: すべての金額・件数はシミュレーションです。事業成果の証拠にはなりません。'
          : '上流コストの一部は契約確定前の予算前提値です。is_estimate 列を確認してください。',
    };
  });

  // ---------------------------------------------------------------- jobs

  app.get('/v1/admin/jobs', { preHandler: staff }, async (req) => {
    const q = z
      .object({ state: z.string().optional(), userId: z.string().uuid().optional(), limit: z.coerce.number().max(200).default(50) })
      .parse(req.query);
    const rows = await query(
      `SELECT j.id, j.user_id, j.state, j.error_code, j.provider_id, j.attempt_count,
              j.created_at, j.finished_at, j.track_id
         FROM generation_jobs j
        WHERE (? IS NULL OR j.state = ?)
          AND (? IS NULL OR j.user_id = ?)
        ORDER BY j.created_at DESC
        LIMIT ?`,
      [q.state ?? null, q.state ?? null, q.userId ?? null, q.userId ?? null, q.limit],
    );
    return { items: rows };
  });

  /** Per-job upstream cost trail (AI-06). */
  app.get('/v1/admin/jobs/:id/costs', { preHandler: staff }, async (req) => {
    const { id } = req.params as { id: string };
    const rows = await query(
      `SELECT provider_id, provider_kind, event_type, billable, cost_minor, currency,
              is_estimate, contract_version, occurred_at
         FROM provider_cost_events WHERE job_id = ? ORDER BY occurred_at`,
      [id],
    );
    return { items: rows };
  });

  // ----------------------------------------------------------- customers

  /**
   * GET /v1/admin/users?email=…
   *
   * The thing that was missing. Every user-facing admin route took a UUID in
   * its path and nothing could produce one from an email address, so giving a
   * customer credits meant reading `users.id` out of a SQL client. The search
   * is email-only and prefix-only on purpose — see `findUsersByEmail` — since
   * a support tool that takes any fragment of anything is a people search.
   */
  app.get(
    '/v1/admin/users',
    {
      preHandler: staff,
      /*
       * The only rate limit in this file, and it is here because this is the
       * one route that reads other people's email addresses in bulk.
       *
       * `findUsersByEmail` says plainly in its own docstring that a prefix
       * search ordered by address with a "there are more" flag is a usable
       * prefix-descent oracle, and that what keeps it closed is the route
       * being staff-only. That is true right up to the moment a staff session
       * is stolen, and then nothing slowed the walk or left a trace. This
       * slows it; the audit row below is the trace.
       *
       * Generous enough that a person typing cannot hit it.
       */
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (req) => {
    // Trimmed BEFORE the length check: `?email=%20%20a%20%20` passed a
    // `min(3)` applied to the raw string and then arrived at the lookup as one
    // character, which answered "no accounts" rather than "that is not a
    // search".
      const { email } = z
        .object({ email: z.string().trim().min(3).max(320) })
        .parse(req.query);
      const found = await findCustomers({ email });
      /*
       * A READ is audited here, which almost nothing else in this file does.
       *
       * The file header says a reason "is written to `audit_logs` together
       * with the before/after state… an unexplained privileged action cannot
       * be recorded — and therefore cannot happen." That was true of every
       * mutating route and of neither read route, and this read is the one
       * that enumerates customers. The query and the number of hits go in;
       * the addresses do not, because the audit table should not become a
       * second copy of the customer list.
       */
      await writeAuditLog({
        actorId: req.user!.id,
        actorRole: req.user!.role,
        action: 'customer.searched',
        subjectType: 'email_prefix',
        subjectId: email.slice(0, 3),
        reason: 'operator console customer lookup',
        after: { matches: found.items.length, more: found.more },
      });
      return found;
    },
  );

  /** One account: balance, where each batch of credits came from, and orders. */
  app.get('/v1/admin/users/:id', { preHandler: staff }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const view = await getCustomer(id);
    // Opening one customer's record is also a read worth a row: it carries
    // the address, the balance and the whole order history.
    await writeAuditLog({
      actorId: req.user!.id,
      actorRole: req.user!.role,
      action: 'customer.opened',
      subjectType: 'user',
      subjectId: id,
      reason: 'operator console customer record',
    });
    return view;
  });

  /**
   * POST /v1/admin/users/:id/grant
   *
   * Gives credits away. `admin` only, and deliberately not `support`: a credit
   * is a generation and a generation is provider cost, so this spends money,
   * which is a different authority from looking at a queue. Compensation below
   * stays open to support — that one is an apology for a failure, bounded at
   * twenty, and refusing it would make support unable to do its job.
   */
  app.post('/v1/admin/users/:id/grant', { preHandler: adminOnly }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = ledgerReasoned
      .extend({
        units: z.number().int().min(1).max(10_000),
        validityDays: z.number().int().min(1).max(3650).optional(),
        idempotencyKey: idempotencyKeySchema.optional(),
      })
      .parse(req.body);
    /*
     * The schema's bounds are a sanity filter, not the policy. The real caps
     * are configuration and live in the service, so the refusal names the
     * actual limit and the daily total — `max(100)` here would have reported
     * "expected <= 100" for a deployment whose limit is 20.
     */
    return giftCredits(ctx, {
      userId: id,
      units: body.units,
      reason: body.reason,
      ...(body.validityDays !== undefined ? { validityDays: body.validityDays } : {}),
      ...(body.idempotencyKey ? { idempotencyKey: body.idempotencyKey } : {}),
      actorId: req.user!.id,
      actorRole: req.user!.role,
    });
  });

  // -------------------------------------------------------- compensation

  /**
   * Issues make-good credits. Never edits an existing consumption row — a new
   * compensation batch is created, so the original flow stays auditable (§6.2).
   */
  app.post('/v1/admin/users/:id/compensate', { preHandler: staff }, async (req) => {
    /*
     * Validated and guarded the same way as `grant`, which it was not.
     *
     * A non-UUID `:id` used to reach the `entitlement_batches` foreign key and
     * surface as a 500; and the deleted-or-suspended refusal that `grant` has
     * — on the stated grounds that crediting the row an executed deletion left
     * behind quietly undoes the deletion — was absent here, on the route that
     * is open to `support` and whose daily allowance is four times larger.
     * The wider door had the weaker checks.
     */
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = ledgerReasoned
      .extend({ units: z.number().int().min(1).max(20), jobId: z.string().uuid().optional() })
      .parse(req.body);

    const result = await withTxRetry(async (tx) => {
      /*
       * The operator's own row first, then the day's total — the same shape
       * the gift path uses, and for the same reason.
       *
       * This route is capped at 20 units per call and was capped at nothing
       * per day, while the gift path's daily cap was being described as the
       * protection against a compromised operator account. Twenty at a time,
       * repeated, is unbounded; and this one is open to `support`, which is
       * the wider door of the two. The allowance is its own
       * (`ADMIN_COMPENSATION_MAX_UNITS_PER_DAY`) and larger, because a real
       * outage means compensating many people at once.
       */
      await lockUser(req.user!.id, tx);
      // And the recipient, before its status is read — same reasoning as
      // `giftCredits`, same lock order, so the two cannot deadlock each other
      // except operator-against-operator, which the retry absorbs.
      await lockUser(id, tx);
      const recipient = await getUser(id, tx);
      if (!recipient || recipient.status === 'deleted' || recipient.deleted_at) {
        throw new AppError('NOT_FOUND', 'no such account');
      }
      if (recipient.status !== 'active') {
        throw new AppError('FORBIDDEN', `this account is ${recipient.status}`);
      }

      const perDay = ctx.config.ADMIN_COMPENSATION_MAX_UNITS_PER_DAY;
      if (perDay > 0) {
        const already = await unitsGrantedByActorSince(
          {
            actorId: req.user!.id,
            sources: ['compensation'],
            since: new Date(Date.now() - 86_400_000),
          },
          tx,
        );
        if (already + body.units > perDay) {
          throw new AppError('VALIDATION_FAILED', 'this would pass your daily compensation limit', {
            limitPerDay: perDay,
            alreadyToday: already,
          });
        }
      }

      const res = await compensateUnits(
        {
          userId: id,
          jobId: body.jobId ?? null,
          units: body.units,
          reason: `operator_compensation: ${body.reason}`,
          actorId: req.user!.id,
          validityDays: ctx.config.EXPIRED_BATCH_COMPENSATION_DAYS,
        },
        tx,
      );
      await writeAuditLog(
        {
          actorId: req.user!.id,
          actorRole: req.user!.role,
          action: 'entitlement.compensated',
          subjectType: 'user',
          subjectId: id,
          reason: body.reason,
          after: { units: body.units, batchId: res.batch.id, created: res.created },
        },
        tx,
      );
      return res;
    });
    return { batchId: result.batch.id, created: result.created, units: body.units };
  });

  // ------------------------------------------------------- rights cases

  app.get('/v1/admin/rights-cases', { preHandler: staff }, async (req) => {
    const q = z.object({ status: z.string().optional() }).parse(req.query);
    const rows = await listRightsCases(q.status);
    return {
      items: rows.map((c) => ({
        id: c.id,
        caseNumber: c.case_number,
        trackId: c.track_id,
        claimType: c.claim_type,
        status: c.status,
        // Support staff see enough to work the case, not the full evidence dump.
        reporterEmail: req.user!.role === 'admin' ? c.reporter_email : maskEmail(c.reporter_email),
        createdAt: c.created_at.toISOString(),
        updatedAt: c.updated_at.toISOString(),
      })),
    };
  });

  app.get('/v1/admin/rights-cases/:id', { preHandler: staff }, async (req) => {
    const { id } = req.params as { id: string };
    const c = await getRightsCase(id);
    if (!c) throw new AppError('NOT_FOUND', 'case not found');
    return {
      id: c.id,
      caseNumber: c.case_number,
      trackId: c.track_id,
      audioSha256: c.audio_sha256,
      claimType: c.claim_type,
      description: c.description,
      evidence: c.evidence,
      status: c.status,
      resolution: c.resolution,
      reporterName: c.reporter_name,
      reporterEmail: req.user!.role === 'admin' ? c.reporter_email : maskEmail(c.reporter_email),
      createdAt: c.created_at.toISOString(),
    };
  });

  /**
   * Restore / uphold / dismiss. Only an admin may change a licence's status,
   * and both the case and the track transition are audited.
   */
  app.post('/v1/admin/rights-cases/:id/resolve', { preHandler: adminOnly }, async (req) => {
    const { id } = req.params as { id: string };
    const body = reasoned
      .extend({ status: z.enum(['under_review', 'dismissed', 'upheld', 'restored']) })
      .parse(req.body);

    const before = await getRightsCase(id);
    if (!before) throw new AppError('NOT_FOUND', 'case not found');

    const updated = await updateRightsCase({ id, status: body.status, resolution: body.reason, assignedTo: req.user!.id });

    if (before.track_id) {
      if (body.status === 'dismissed' || body.status === 'restored') {
        await setTrackState({ trackId: before.track_id, state: 'deliverable', reason: null });
        await setLicenseStatus({ trackId: before.track_id, status: 'active', reason: body.reason });
      } else if (body.status === 'upheld') {
        await setTrackState({ trackId: before.track_id, state: 'suspended', reason: body.reason });
        await setLicenseStatus({ trackId: before.track_id, status: 'revoked', reason: body.reason });
      }
    }

    await writeAuditLog({
      actorId: req.user!.id,
      actorRole: req.user!.role,
      action: 'rights_case.resolved',
      subjectType: 'rights_case',
      subjectId: id,
      reason: body.reason,
      before: { status: before.status },
      after: { status: body.status },
    });

    return {
      caseNumber: updated?.case_number,
      status: body.status,
      note:
        body.status === 'upheld'
          ? '外部プラットフォームや利用者の端末に既にダウンロードされたファイルを技術的に回収することはできません。通知と協力の窓口を案内してください。'
          : null,
    };
  });

  // --------------------------------------------------- operational switches

  app.get('/v1/admin/settings', { preHandler: staff }, async () => ({ items: await listSettings() }));

  /**
   * Runtime switches can only narrow what configuration already allows — see
   * `AppContext.features`. A switch cannot re-enable something the run mode
   * forbids, so an operator cannot turn on commercial delivery from here.
   */
  app.put('/v1/admin/settings/:key', { preHandler: adminOnly }, async (req) => {
    const { key } = req.params as { key: string };
    const body = reasoned.extend({ value: z.unknown() }).parse(req.body);
    const allowed = ['feature_overrides', 'daily_budget_minor', 'maintenance_notice'];
    if (!allowed.includes(key)) throw new AppError('VALIDATION_FAILED', `unknown setting "${key}"`);

    await setSetting({ key, value: body.value, updatedBy: req.user!.id, reason: body.reason });
    await writeAuditLog({
      actorId: req.user!.id,
      actorRole: req.user!.role,
      action: 'setting.updated',
      subjectType: 'setting',
      subjectId: key,
      reason: body.reason,
      after: { value: body.value },
    });
    return { key, value: body.value };
  });

  // ------------------------------------------------------ reconciliation

  /** Daily ledger check (§6.2). Reports discrepancies; never auto-corrects them. */
  app.get('/v1/admin/reconciliation', { preHandler: staff }, async () => {
    const rows = await reconcileBalances();
    return {
      discrepancies: rows,
      ok: rows.length === 0,
      note: rows.length
        ? '差異は自動修正しません。原因を特定し、補償フローで訂正してください。'
        : null,
    };
  });

  // --------------------------------------------------- account deletion (SEC-11)

  /**
   * The deletion queue. Staff can see what is waiting and what happened.
   *
   * Until there was a table to list, "what deletion requests are outstanding"
   * had no answer: the request wrote one `analytics_events` row and nothing
   * else, so the only way to find a pending erasure was to know it existed.
   */
  app.get('/v1/admin/deletions', { preHandler: staff }, async (req) => {
    const q = z
      .object({
        status: z
          .enum(['requested', 'verified', 'executing', 'executed', 'failed', 'cancelled'])
          .optional(),
        limit: z.coerce.number().max(200).default(50),
      })
      .parse(req.query);
    const items = await listAccountDeletions(q);
    return {
      items: items.map((d) => ({
        id: d.id,
        ticket: d.ticket,
        status: d.status,
        requestedAt: d.requested_at.toISOString(),
        verifiedAt: d.verified_at?.toISOString() ?? null,
        executedAt: d.executed_at?.toISOString() ?? null,
        outcome: d.outcome,
        failure: d.failure,
      })),
    };
  });

  /**
   * A human states that the person asking owns the account.
   *
   * Separate from executing it, and `adminOnly`, because this is the step that
   * turns a sentence into an irreversible erasure. "Delete my account" arriving
   * on a stolen session must not be self-executing, which is also what the
   * request endpoint has always told users ("Deletion runs after identity
   * verification") — this is the first code that makes that sentence true.
   */
  app.post('/v1/admin/deletions/:id/verify', { preHandler: adminOnly }, async (req) => {
    const { id } = req.params as { id: string };
    const body = reasoned.parse(req.body);

    const before = await getAccountDeletion(id);
    if (!before) throw new AppError('NOT_FOUND', 'deletion request not found');
    if (!(await markAccountDeletionVerified({ id, verifiedBy: req.user!.id }))) {
      throw new AppError('CONFLICT', `deletion request is ${before.status}, not awaiting verification`);
    }

    await writeAuditLog({
      actorId: req.user!.id,
      actorRole: req.user!.role,
      action: 'account_deletion.verified',
      subjectType: 'account_deletion',
      subjectId: id,
      reason: body.reason,
      before: { status: before.status },
      after: { status: 'verified' },
    });

    return { id, status: 'verified' };
  });

  /**
   * Carry it out.
   *
   * Synchronous, and deliberately not a background sweep: an erasure is rare,
   * irreversible and worth an operator watching it finish. The response is the
   * outcome — what went, and what the three holds kept — rather than an
   * acknowledgement that something was scheduled.
   */
  app.post('/v1/admin/deletions/:id/execute', { preHandler: adminOnly }, async (req) => {
    const { id } = req.params as { id: string };
    const body = reasoned.parse(req.body);

    const deletion = await getAccountDeletion(id);
    if (!deletion) throw new AppError('NOT_FOUND', 'deletion request not found');
    // `failed` is retryable: a run that could not reach storage left objects
    // behind, and the identity check that let it start does not expire because
    // a bucket was briefly unreachable. The claim inside the service is the
    // real guard; this check is only here to give a better error.
    if (deletion.status !== 'verified' && deletion.status !== 'failed' && deletion.status !== 'executing') {
      throw new AppError('CONFLICT', `deletion request is ${deletion.status}, not verified`);
    }

    const outcome = await executeAccountDeletion(ctx, deletion, req.log);

    await writeAuditLog({
      actorId: req.user!.id,
      actorRole: req.user!.role,
      action: 'account_deletion.executed',
      subjectType: 'account_deletion',
      subjectId: id,
      reason: body.reason,
      before: { status: 'verified' },
      after: { status: 'executed', ...outcome },
    });

    return { id, status: 'executed', outcome };
  });

  /**
   * Card orders held before delivery (⑥ in docs/FRAUD_PREVENTION.md).
   *
   * Staff can see the queue; only an admin decides, like every other action
   * about money. Releasing hands over what was bought; refusing delivers
   * nothing and leaves the refund to a person in Stripe, which is said
   * plainly rather than implied by a button.
   */
  app.get('/v1/admin/order-reviews', { preHandler: staff }, async () => ({
    items: await heldOrderQueue(),
  }));

  app.post('/v1/admin/order-reviews/:id/decide', { preHandler: adminOnly }, async (req) => {
    const { id } = req.params as { id: string };
    const body = z
      .object({ decision: z.enum(['release', 'refuse']), reason: z.string().min(3).max(500) })
      .parse(req.body);
    return decideHeldOrder({
      reviewId: id,
      decision: body.decision,
      reason: body.reason,
      actorId: req.user!.id,
      actorRole: req.user!.role,
    });
  });

  app.get('/v1/admin/audit-logs', { preHandler: staff }, async (req) => {
    const q = z
      .object({ subjectType: z.string().optional(), subjectId: z.string().optional(), limit: z.coerce.number().max(200).default(100) })
      .parse(req.query);
    return { items: await listAuditLogs(q) };
  });
}

function maskEmail(email: string): string {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 2)}***@${domain}`;
}
