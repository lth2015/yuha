import { AppError } from '@yuha/contracts';
import {
  balancesFor,
  findUsersByEmail,
  getBalance,
  getUser,
  giftUnits,
  listBatches,
  listOrders,
  lockUser,
  unitsGrantedByActorSince,
  withTxRetry,
  writeAuditLog,
  type UserRow,
} from '@yuha/db';
import type { AppContext } from '../context.js';

/**
 * Looking a customer up, and giving them credits.
 *
 * Neither was possible. `POST /v1/admin/users/:id/compensate` has existed
 * since the first release, and nothing anywhere could turn an email address
 * into that `:id` — no list, no search, no console screen. So the documented
 * way to give somebody credits was to open a SQL client and read `users.id`
 * by hand, and `services/purchase-cap.ts` meanwhile told the reader that an
 * operator "can issue credits directly from the console", which was simply not
 * true. That comment is corrected in the same change as this file.
 *
 * Two actions, kept apart on purpose:
 *
 *   - **compensate** (`routes/admin.ts`) is a make-good. Capped at 20 a call
 *     and at `ADMIN_COMPENSATION_MAX_UNITS_PER_DAY` per operator per day,
 *     dated by EXPIRED_BATCH_COMPENSATION_DAYS, recorded as `compensation` —
 *     a cost we caused by failing. It predates this file, but it is not
 *     unchanged: the daily total, the account guards and the uuid check were
 *     all added alongside, because capped per call is not capped and it is
 *     the wider of the two doors.
 *   - **gift** (here) is a giveaway. Its own cap, its own validity, its own
 *     ledger source, admin-only.
 *
 * Collapsing them would have been less code and a worse answer: every
 * giveaway would read in the books as an apology for a failure that never
 * happened, and the first time the provider bill outruns revenue nobody could
 * separate the two.
 */

export interface OperatorUserView {
  userId: string;
  email: string;
  displayName: string | null;
  role: string;
  status: string;
  createdAt: string;
  balance: { available: number; reserved: number; consumed: number; granted: number };
  /** True when there are more batches than this view carries. */
  creditsTruncated: boolean;
  /** True when there are more orders than this view carries. */
  ordersTruncated: boolean;
  credits: Array<{
    batchId: string;
    source: string;
    units: number;
    reserved: number;
    consumed: number;
    status: string;
    expiresAt: string | null;
    createdAt: string;
  }>;
  orders: Array<{
    orderId: string;
    priceKey: string;
    amountMinor: number;
    currency: string;
    status: string;
    createdAt: string;
  }>;
}

function viewOf(user: UserRow): Pick<OperatorUserView, 'userId' | 'email' | 'displayName' | 'role' | 'status' | 'createdAt'> {
  return {
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    status: user.status,
    createdAt: user.created_at.toISOString(),
  };
}

/** Accounts matching an email, for an operator who knows the address. */
export async function findCustomers(params: { email: string }): Promise<{
  items: Array<ReturnType<typeof viewOf> & { available: number }>;
  more: boolean;
}> {
  const { items, more } = await findUsersByEmail({ email: params.email });
  /*
   * One query for every balance, not one per row. This was a `getBalance` in a
   * loop — up to ten extra round trips per search, and a search happens on
   * every press of the button.
   */
  const balances = await balancesFor(items.map((u) => u.id));
  return {
    items: items.map((user) => ({ ...viewOf(user), available: balances.get(user.id) ?? 0 })),
    more,
  };
}

/**
 * One customer, with where their credits came from.
 *
 * The batch list is the point rather than decoration: an operator about to
 * give somebody fifty credits should see that they already hold forty, that
 * thirty of them expire next week, and that the last lot was a compensation —
 * which usually changes the decision. A single "available" number hides all
 * three.
 */
export async function getCustomer(userId: string): Promise<OperatorUserView> {
  const user = await getUser(userId);
  if (!user) throw new AppError('NOT_FOUND', 'no such account');
  /*
   * A deleted account still opens, deliberately, and `status` says so.
   *
   * The search excludes deleted rows by construction and `giftCredits`
   * refuses them, so the three paths looked inconsistent. They are not meant
   * to be the same rule: an erasure anonymises rather than removes
   * (`packages/db/src/deletions.ts`), the order and credit history is
   * deliberately retained for statutory reasons, and support answering "what
   * happened to this account" needs to be able to read it. What must not
   * happen is WRITING to it, which is the refusal that exists. Saying so here
   * rather than leaving the difference to be read as an oversight.
   */

  const BATCHES = 100;
  const ORDERS = 50;
  const [balance, batches, orders] = await Promise.all([
    getBalance(userId),
    // Bounded, and the caller is told when the view is partial. Unbounded,
    // this loaded every batch an account had ever held — and a gift mints a
    // new one each time, so the count grows with operator activity.
    listBatches(userId, undefined, BATCHES + 1),
    listOrders(userId, ORDERS + 1),
  ]);

  return {
    ...viewOf(user),
    balance,
    /*
     * Both lists say whether they are complete. `listOrders` silently capped
     * at 50 with no flag, on the screen whose stated purpose is to show what
     * an account has bought before deciding a gift — a list that lies by
     * omission is worse than a short one that says so.
     */
    creditsTruncated: batches.length > BATCHES,
    ordersTruncated: orders.length > ORDERS,
    credits: batches.slice(0, BATCHES).map((b) => ({
      batchId: b.id,
      source: b.source,
      units: b.granted_units,
      reserved: b.reserved_units,
      consumed: b.consumed_units,
      status: b.status,
      expiresAt: b.expires_at?.toISOString() ?? null,
      createdAt: b.created_at.toISOString(),
    })),
    orders: orders.slice(0, ORDERS).map((o) => ({
      orderId: o.id,
      priceKey: o.price_key,
      amountMinor: o.amount_minor,
      currency: o.currency,
      status: o.status,
      createdAt: o.created_at.toISOString(),
    })),
  };
}

export interface GiftResult {
  batchId: string;
  units: number;
  expiresAt: string;
  /** -1 when no daily limit is configured. */
  remainingToday: number;
  /** True when an idempotency key matched an earlier gift and nothing new was written. */
  replayed?: boolean;
}

/**
 * Gives a customer credits, on an operator's authority and nobody else's.
 *
 * Every refusal below is a number from configuration rather than a judgement,
 * and each one answers a different failure:
 *
 *   - the per-gift cap: 500 instead of 50 is one keystroke;
 *   - the daily cap per operator: the per-gift cap bounds nothing on its own,
 *     because fifty gifts of fifty is still two and a half thousand, and the
 *     account that does that is a compromised one rather than a careless one;
 *   - the validity: a giveaway that never expires is a liability nobody
 *     remembers agreeing to. The operator may shorten it, never lengthen it.
 *
 * Refused for a deleted or suspended account: granting credits to a row left
 * behind by an executed deletion would quietly undo the deletion, and a
 * suspended account is one somebody decided to stop serving.
 */
export async function giftCredits(
  ctx: AppContext,
  params: {
    userId: string;
    units: number;
    reason: string;
    validityDays?: number;
    actorId: string;
    actorRole: string;
    /**
     * Makes a retry a retry rather than a second gift.
     *
     * This route was the only money endpoint in the API without one, and
     * `source_ref: gift:<random>` deliberately defeated the uniqueness on
     * (user, source, source_ref) that PAY-05 names and that every other grant
     * leans on — so the gift path had no replay protection at any layer. The
     * failure is not theoretical: the API commits, the response is lost to an
     * idle timeout or a pod roll, the console shows an error beside the
     * pre-gift balance, and the operator types 50 again.
     *
     * "Asking twice means twice" is still true and is still the point — a
     * deliberate second gift sends a NEW key. What a key buys is the ability
     * to tell the two apart, which a random ref per attempt cannot.
     */
    idempotencyKey?: string;
  },
): Promise<GiftResult> {
  const perGift = ctx.config.ADMIN_GRANT_MAX_UNITS;
  const perDay = ctx.config.ADMIN_GRANT_MAX_UNITS_PER_DAY;
  if (perGift <= 0) throw new AppError('FORBIDDEN', 'gifting credits is switched off on this deployment');

  const reason = params.reason.trim();
  if (reason.length < 3) throw new AppError('VALIDATION_FAILED', 'a reason is required');
  if (!Number.isInteger(params.units) || params.units < 1) {
    throw new AppError('VALIDATION_FAILED', 'units must be a positive whole number');
  }
  if (params.units > perGift) {
    throw new AppError('VALIDATION_FAILED', `one gift may carry at most ${perGift} credits`, {
      limit: perGift,
    });
  }

  const maxDays = ctx.config.ADMIN_GRANT_VALIDITY_DAYS;
  const validityDays = params.validityDays ?? maxDays;
  if (!Number.isInteger(validityDays) || validityDays < 1 || validityDays > maxDays) {
    throw new AppError('VALIDATION_FAILED', `validity must be between 1 and ${maxDays} days`, {
      maxDays,
    });
  }

  /*
   * Everything that decides the outcome happens inside ONE transaction, and
   * the first thing it does is lock the OPERATOR'S own row.
   *
   * That lock is the daily cap. Without it the cap is a suggestion: the read
   * below is a plain read, so two of this operator's requests aimed at two
   * different recipients take two different recipient locks, both see the same
   * stale total, and both commit. Measured before the lock was added — fifty
   * parallel requests wrote five thousand units against a five-hundred-a-day
   * limit, and `remainingToday` reported the wrong number to all fifty. The
   * earlier version of this comment claimed the overshoot was "at most one
   * gift"; it was unbounded.
   *
   * The account is read inside the transaction too. Read outside, the
   * suspended-and-deleted refusal is a check against a row that can change
   * before the write lands.
   *
   * Two operators gifting each other in the same instant can deadlock on the
   * actor/recipient pair. InnoDB detects it and one request fails with a
   * retryable error, which is the correct outcome for something this rare —
   * and much better than the alternative of not locking.
   */
  return withTxRetry(async (tx) => {
    await lockUser(params.actorId, tx);
    /*
     * The recipient's row too, and BEFORE reading its status.
     *
     * `getUser` is a plain read, so under REPEATABLE READ it pins a snapshot
     * and the suspended-or-deleted refusal becomes a check against a row that
     * may already have changed — `executeAccountDeletion` commits
     * `anonymiseUser` outside any transaction, so the window is real and, if
     * the deletion holds this row when `grantUnits` reaches it, is as long as
     * `innodb_lock_wait_timeout`. Credits written against a tombstone are
     * invisible for ever (the search excludes deleted rows by construction)
     * and are rows created after an erasure completed.
     *
     * Order matters and is actor-then-recipient here and in the compensate
     * route, the only two paths that take two user-row locks. Every other
     * lock site takes exactly one, so the only possible cycle is two
     * operators acting on each other at the same instant — which `withTxRetry`
     * now handles instead of surfacing as a 500.
     */
    await lockUser(params.userId, tx);

    const user = await getUser(params.userId, tx);
    if (!user || user.status === 'deleted' || user.deleted_at) {
      throw new AppError('NOT_FOUND', 'no such account');
    }
    if (user.status !== 'active') {
      throw new AppError('FORBIDDEN', `this account is ${user.status}`);
    }

    const already =
      perDay > 0
        ? await unitsGrantedByActorSince(
            {
              actorId: params.actorId,
              sources: ['operator_gift'],
              since: new Date(Date.now() - 86_400_000),
            },
            tx,
          )
        : 0;
    if (perDay > 0 && already + params.units > perDay) {
      throw new AppError('VALIDATION_FAILED', 'this would pass your daily giving limit', {
        limitPerDay: perDay,
        alreadyToday: already,
      });
    }

    const { batch, created } = await giftUnits(
      {
        userId: params.userId,
        units: params.units,
        reason: `operator_gift: ${reason}`,
        actorId: params.actorId,
        validityDays,
        ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
      },
      tx,
    );

    /*
     * A replay returns what the first attempt did, and writes no second audit
     * row: the operator asked once. The units reported are the batch's, not
     * the request's, so a retry that differed in amount cannot be mistaken
     * for having applied the new amount.
     */
    if (!created) {
      return {
        batchId: batch.id,
        units: batch.granted_units,
        expiresAt: batch.expires_at!.toISOString(),
        remainingToday: perDay > 0 ? Math.max(perDay - already, 0) : -1,
        replayed: true,
      };
    }

    await writeAuditLog(
      {
        actorId: params.actorId,
        actorRole: params.actorRole,
        action: 'entitlement.gifted',
        subjectType: 'user',
        subjectId: params.userId,
        reason,
        after: {
          units: params.units,
          batchId: batch.id,
          validityDays,
          expiresAt: batch.expires_at?.toISOString() ?? null,
        },
      },
      tx,
    );

    return {
      batchId: batch.id,
      units: params.units,
      expiresAt: batch.expires_at!.toISOString(),
      remainingToday: perDay > 0 ? perDay - already - params.units : -1,
    };
  });
}
