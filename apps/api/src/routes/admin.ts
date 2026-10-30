import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, UserRole, idempotencyKeySchema } from '@yuha/contracts';
import {
  compensateUnits,
  getUser,
  lockUser,
  unitsGrantedByActorSince,
  getAccountDeletion,
  getRightsCase,
  getTrack,
  listAccountDeletions,
  listAuditLogs,
  listAuditForConsole,
  listOrdersForConsole,
  statsReport,
  jstToday,
  jstDayStartUtc,
  bucketKeys,
  listRightsCases,
  listSettings,
  markAccountDeletionVerified,
  query,
  reconcileBalances,
  reporting,
  setLicenseStatus,
  setSetting,
  getSetting,
  setTrackState,
  updateRightsCase,
  withTx,
  withTxRetry,
  writeAuditLog,
} from '@yuha/db';
import { NETX_BSC } from '@yuha/providers';
import { NETX_PAUSE_SETTING, type AppContext } from '../context.js';
import { executeAccountDeletion } from '../services/deletion.js';
import { decideHeldOrder, heldOrderQueue } from '../services/order-review.js';
import { compensateAsOperator, findCustomers, getCustomer, giftCredits } from '../services/operator-grant.js';
import { creditResetOverview, getCreditResetView, startCreditReset } from '../services/credit-reset.js';
import { getLyricRealignView, lyricRealignOverview, startLyricRealign } from '../services/lyric-realign.js';
import { changeRole, reactivateAccount, suspendAccount } from '../services/account-admin.js';

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
/** When this API process started, for the overview's build line. */
const PROCESS_STARTED_AT = new Date().toISOString();

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
      // Which code is answering: an acceptance record names this, not a
      // local checkout. Staff only, like everything here.
      build: { sha: process.env['BUILD_SHA'] ?? null, startedAt: PROCESS_STARTED_AT },
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

  // ------------------------------------------------------------ dashboard

  /**
   * GET /v1/admin/stats?granularity=day|week|month|year&from=YYYY-MM-DD&to=YYYY-MM-DD
   *
   * Visits, sign-ups, generations, paid orders and revenue (by card / JPYC /
   * USDC), refunds and credits, in Japan-time buckets, with totals for the
   * range and for the same span immediately before it. What each number
   * counts is written once, in packages/db/src/admin-stats.ts.
   *
   * Without dates: the last 30 days by day, 12 weeks by week, 12 months by
   * month, 5 years by year — each ending today in Japan.
   */
  const DEFAULT_SPAN_DAYS = { day: 30, week: 12 * 7, month: 365, year: 5 * 365 } as const;
  app.get('/v1/admin/stats', { preHandler: staff }, async (req) => {
    const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
    const q = z
      .object({
        granularity: z.enum(['day', 'week', 'month', 'year']).default('day'),
        from: ymd.optional(),
        to: ymd.optional(),
      })
      .parse(req.query);
    const to = q.to ?? jstToday();
    const from =
      q.from ??
      new Date(Date.parse(`${to}T00:00:00Z`) - (DEFAULT_SPAN_DAYS[q.granularity] - 1) * 86_400_000)
        .toISOString()
        .slice(0, 10);
    if (from > to) throw new AppError('VALIDATION_FAILED', '`from` is after `to`');
    // Bounded by bucket count rather than by days: 400 daily buckets is a
    // chart nobody can read, while ten years by month is fine.
    if (bucketKeys(from, to, q.granularity).length > 400) {
      throw new AppError('VALIDATION_FAILED', 'that range has too many buckets for this granularity — pick a coarser one');
    }
    return statsReport({ granularity: q.granularity, from, to });
  });

  // --------------------------------------------------------------- orders

  /** Orders across all accounts, newest first, with how each was paid. */
  app.get('/v1/admin/orders', { preHandler: staff }, async (req) => {
    const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
    const q = z
      .object({
        status: z.enum(['pending', 'paid', 'failed', 'refunded', 'partially_refunded', 'canceled']).optional(),
        method: z.enum(['card', 'jpyc', 'usdc', 'netx']).optional(),
        email: z.string().trim().min(1).max(320).optional(),
        from: ymd.optional(),
        to: ymd.optional(),
        before: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
      })
      .parse(req.query);
    return listOrdersForConsole({
      ...(q.status ? { status: q.status } : {}),
      ...(q.method ? { method: q.method } : {}),
      ...(q.email ? { email: q.email } : {}),
      ...(q.from ? { from: jstDayStartUtc(q.from) } : {}),
      ...(q.to ? { to: new Date(jstDayStartUtc(q.to).getTime() + 86_400_000) } : {}),
      ...(q.before ? { before: new Date(q.before) } : {}),
      limit: q.limit,
    });
  });

  // ------------------------------------------------------------ audit log

  /** The audit log with the people resolved, for the console's audit tab. */
  app.get('/v1/admin/audit', { preHandler: staff }, async (req) => {
    const q = z
      .object({
        action: z.string().trim().min(1).max(64).optional(),
        email: z.string().trim().min(1).max(320).optional(),
        before: z.string().datetime().optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse(req.query);
    return listAuditForConsole({
      ...(q.action ? { action: q.action } : {}),
      ...(q.email ? { email: q.email } : {}),
      ...(q.before ? { before: new Date(q.before) } : {}),
      limit: q.limit,
    });
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

  // -------------------------------------------------------- credit resets

  /**
   * Credit resets (docs/CREDIT_RESET.md). Admin only, like gifts: a reset
   * hands out credits to every account at once, and every credit is provider
   * cost. GET shows what a reset started now would give and the recent ones;
   * POST starts one (or continues the one its key started) and returns at
   * once, 202, while it runs in the background.
   */
  app.get('/v1/admin/credit-resets', { preHandler: adminOnly }, async () => creditResetOverview(ctx));

  app.get('/v1/admin/credit-resets/:id', { preHandler: adminOnly }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return getCreditResetView(id);
  });

  app.post('/v1/admin/credit-resets', { preHandler: adminOnly }, async (req, reply) => {
    const body = z
      .object({ reason: z.string().trim().min(3).max(500), idempotencyKey: idempotencyKeySchema })
      .parse(req.body);
    const view = await startCreditReset(ctx, {
      idempotencyKey: body.idempotencyKey,
      reason: body.reason,
      actorId: req.user!.id,
      actorRole: req.user!.role,
    });
    return reply.status(202).send(view);
  });

  /*
   * Lyric re-alignment (docs/LYRIC_ALIGNMENT.md). Admin only: every song is a
   * GPU job on the box that renders customers' songs. GET shows how many
   * songs a run would visit and the recent runs; POST starts one (or
   * continues the one its key started) and returns at once, 202.
   */
  app.get('/v1/admin/lyric-realignments', { preHandler: adminOnly }, async () => lyricRealignOverview(ctx));

  app.get('/v1/admin/lyric-realignments/:id', { preHandler: adminOnly }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    return getLyricRealignView(id);
  });

  app.post('/v1/admin/lyric-realignments', { preHandler: adminOnly }, async (req, reply) => {
    const body = z
      .object({ reason: z.string().trim().min(3).max(500), idempotencyKey: idempotencyKeySchema })
      .parse(req.body);
    const view = await startLyricRealign(ctx, {
      idempotencyKey: body.idempotencyKey,
      reason: body.reason,
      actorId: req.user!.id,
      actorRole: req.user!.role,
    });
    return reply.status(202).send(view);
  });

  // -------------------------------------------------------- compensation

  /**
   * Issues make-good credits. Never edits an existing consumption row — a new
   * compensation batch is created, so the original flow stays auditable (§6.2).
   */
  /*
   * Suspend, reactivate, change role. Admin only, reason required, audited in
   * the same transaction as the change — services/account-admin.ts says what
   * a suspension does and does not do, and why each guard exists.
   */
  app.post('/v1/admin/users/:id/suspend', { preHandler: adminOnly }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = reasoned.parse(req.body);
    return suspendAccount({ actor: { id: req.user!.id, role: req.user!.role }, userId: id, reason: body.reason });
  });

  app.post('/v1/admin/users/:id/reactivate', { preHandler: adminOnly }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = reasoned.parse(req.body);
    return reactivateAccount({ actor: { id: req.user!.id, role: req.user!.role }, userId: id, reason: body.reason });
  });

  app.post('/v1/admin/users/:id/role', { preHandler: adminOnly }, async (req) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(req.params);
    const body = reasoned.extend({ role: UserRole }).parse(req.body);
    return changeRole({
      actor: { id: req.user!.id, role: req.user!.role },
      userId: id,
      role: body.role,
      reason: body.reason,
    });
  });

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

    const result = await withTxRetry((tx) =>
      compensateAsOperator(
        ctx,
        { actor: req.user!, userId: id, jobId: body.jobId ?? null, units: body.units, reason: body.reason },
        tx,
      ),
    );
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
      // Under review is where a pause is decided: a claim no longer pauses a
      // song on arrival (rights.ts), so taking it up is the act that does.
      if (body.status === 'under_review') {
        const track = await getTrack(before.track_id);
        if (track?.state === 'deliverable') {
          await setTrackState({ trackId: before.track_id, state: 'suspended', reason: `rights_case:${before.case_number}` });
          await setLicenseStatus({ trackId: before.track_id, status: 'suspended', reason: `rights_case:${before.case_number}` });
        }
      } else if (body.status === 'dismissed' || body.status === 'restored') {
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

  /*
   * NETX: pause and resume (docs/NETX_PAYMENT.md §4).
   *
   * Its own endpoint AND its own setting key (`NETX_PAUSE_SETTING`). It
   * first lived inside `feature_overrides`, which is one object holding every
   * switch and which the generic settings PUT replaces whole — so the
   * generation runbook (docs/OPERATIONS.md §8) silently resumed a paused NETX
   * at a fixed price below the market. A key of its own has one writer, and
   * the write is a single value, so there is nothing to merge or to lose.
   *
   * Pausing stops NETX being offered and quoted on the next request. It does
   * not stop the scanner: a buyer who was quoted and has paid is still
   * credited. Resuming cannot turn on what configuration has off.
   */
  app.get('/v1/admin/netx-payments', { preHandler: staff }, async () => {
    const features = await ctx.features();
    return {
      configured: ctx.config.STABLECOIN_ENABLED && ctx.config.STABLECOIN_NETX_ENABLED,
      accepting: features.netxPaymentsEnabled,
      yenPerToken: NETX_BSC.pricing.kind === 'fixed-yen' ? NETX_BSC.pricing.yenPerToken : null,
    };
  });

  app.put('/v1/admin/netx-payments', { preHandler: adminOnly }, async (req) => {
    const body = reasoned.extend({ accepting: z.boolean() }).parse(req.body);
    const before = await getSetting<{ accepting?: boolean }>(NETX_PAUSE_SETTING, {});
    await setSetting({ key: NETX_PAUSE_SETTING, value: { accepting: body.accepting }, updatedBy: req.user!.id, reason: body.reason });
    await writeAuditLog({
      actorId: req.user!.id,
      actorRole: req.user!.role,
      action: body.accepting ? 'payments.netx_resumed' : 'payments.netx_paused',
      subjectType: 'setting',
      subjectId: NETX_PAUSE_SETTING,
      reason: body.reason,
      before: { accepting: before.accepting !== false },
      after: { accepting: body.accepting },
    });
    const features = await ctx.features();
    return {
      configured: ctx.config.STABLECOIN_ENABLED && ctx.config.STABLECOIN_NETX_ENABLED,
      accepting: features.netxPaymentsEnabled,
      yenPerToken: NETX_BSC.pricing.kind === 'fixed-yen' ? NETX_BSC.pricing.yenPerToken : null,
    };
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
