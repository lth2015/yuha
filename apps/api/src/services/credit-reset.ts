import { AppError } from '@yuha/contracts';
import {
  accountsAfter,
  createCreditReset,
  finishCreditReset,
  getCreditReset,
  listCreditResets,
  nextResetWindowStart,
  previewCreditReset,
  resetAccount,
  withTxRetry,
  writeAuditLog,
  type CreditResetRow,
} from '@yuha/db';
import type { AppContext } from '../context.js';

/**
 * Credit resets, as the console sees them (docs/CREDIT_RESET.md).
 *
 * A reset is started by an admin and runs in the background, account by
 * account, because a single request cannot be trusted to outlive thousands of
 * transactions behind a 60-second load balancer. The console polls it. If the
 * process stops part way (a pod roll), the reset stays `running` with its
 * cursor, and starting it again with the same key continues from there.
 */
export interface CreditResetView {
  id: string;
  idempotencyKey: string;
  status: 'running' | 'done';
  reason: string;
  floor: number;
  bonus: number;
  windowStart: string;
  usersSeen: number;
  usersTopped: number;
  unitsTopped: number;
  usersBonus: number;
  unitsBonus: number;
  createdAt: string;
  finishedAt: string | null;
  /** True while this process is running it; false for one left running by a process that stopped. */
  active: boolean;
}

const running = new Set<string>();

function viewOf(r: CreditResetRow): CreditResetView {
  return {
    id: r.id,
    idempotencyKey: r.idempotency_key,
    status: r.status,
    reason: r.reason,
    floor: r.floor_units,
    bonus: r.bonus_units,
    windowStart: r.window_start.toISOString(),
    usersSeen: r.users_seen,
    usersTopped: r.users_topped,
    unitsTopped: r.units_topped,
    usersBonus: r.users_bonus,
    unitsBonus: r.units_bonus,
    createdAt: r.created_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
    active: running.has(r.id),
  };
}

export async function creditResetOverview(ctx: AppContext) {
  const floor = ctx.config.CREDIT_RESET_FLOOR;
  const bonus = ctx.config.CREDIT_RESET_PAID_BONUS;
  const windowStart = await nextResetWindowStart();
  const [preview, resets] = await Promise.all([previewCreditReset(floor, bonus, windowStart), listCreditResets(10)]);
  return { preview: { ...preview, floor, bonus, windowStart: windowStart.toISOString() }, resets: resets.map(viewOf) };
}

export async function getCreditResetView(id: string): Promise<CreditResetView> {
  const r = await getCreditReset(id);
  if (!r) throw new AppError('NOT_FOUND', 'no such reset');
  return viewOf(r);
}

/** Starts a reset, or continues the one this key started. Returns at once; the run goes on in the background. */
export async function startCreditReset(
  ctx: AppContext,
  params: { idempotencyKey: string; reason: string; actorId: string; actorRole: string },
): Promise<CreditResetView> {
  const reason = params.reason.trim();
  if (reason.length < 3) throw new AppError('VALIDATION_FAILED', 'a reason is required');
  const floor = ctx.config.CREDIT_RESET_FLOOR;
  const bonus = ctx.config.CREDIT_RESET_PAID_BONUS;
  if (floor < 0 || bonus < 0) throw new AppError('VALIDATION_FAILED', 'reset amounts must not be negative');

  const out = await withTxRetry(async (tx) => {
    const res = await createCreditReset({ idempotencyKey: params.idempotencyKey, actorId: params.actorId, reason, floor, bonus }, tx);
    if ('created' in res && res.created) {
      await writeAuditLog(
        {
          actorId: params.actorId,
          actorRole: params.actorRole,
          action: 'credit_reset.started',
          subjectType: 'credit_reset',
          subjectId: res.reset.id,
          reason,
          after: { floor, bonus, windowStart: res.reset.window_start.toISOString() },
        },
        tx,
      );
    }
    return res;
  });
  if ('blockedBy' in out) {
    throw new AppError('CONFLICT', 'another reset is unfinished; continue that one first', { resetId: out.blockedBy.id });
  }
  if (out.reset.status === 'running' && !running.has(out.reset.id)) {
    running.add(out.reset.id);
    void runCreditReset(out.reset.id, params.actorRole)
      .catch((err) =>
        // Left `running` with its cursor: the console offers to continue it.
        console.log(JSON.stringify({ level: 'error', component: 'credit_reset', ts: new Date().toISOString(), msg: 'credit_reset_stopped', resetId: out.reset.id, error: (err as Error).message })),
      )
      .finally(() => running.delete(out.reset.id));
  }
  return viewOf((await getCreditReset(out.reset.id))!);
}

async function runCreditReset(id: string, actorRole: string): Promise<void> {
  for (;;) {
    const reset = await getCreditReset(id);
    if (!reset || reset.status !== 'running') return;
    const ids = await accountsAfter(reset.cursor_user_id, 200);
    if (ids.length === 0) break;
    for (const userId of ids) {
      await withTxRetry((tx) => resetAccount(reset, userId, tx));
    }
  }
  await finishCreditReset(id);
  const done = (await getCreditReset(id))!;
  await writeAuditLog({
    actorId: done.actor_id,
    actorRole,
    action: 'credit_reset.finished',
    subjectType: 'credit_reset',
    subjectId: id,
    reason: done.reason,
    after: {
      usersSeen: done.users_seen,
      usersTopped: done.users_topped,
      unitsTopped: done.units_topped,
      usersBonus: done.users_bonus,
      unitsBonus: done.units_bonus,
    },
  });
}
