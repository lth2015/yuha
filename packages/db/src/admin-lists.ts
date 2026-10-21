import { query } from './pool.js';
import { paymentMethodOf, type ConsolePaymentMethod } from './admin-stats.js';

/**
 * The two operator lists that read across accounts: orders and the audit log.
 *
 * Both are staff-only at the route, newest first, capped, and paged by the
 * timestamp of the last row seen (`before`), so a page cannot shift under the
 * reader while new rows arrive. The email filter is a prefix on the active
 * address, the same rule as the customer search, and never matches a deleted
 * account's anonymised address.
 */
const escapeLike = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`);

export interface ConsoleOrderRow {
  orderId: string;
  userId: string;
  email: string;
  priceKey: string;
  kind: string;
  method: ConsolePaymentMethod;
  amountMinor: number;
  refundedMinor: number;
  currency: string;
  status: string;
  heldForReview: boolean;
  entitlementGranted: boolean;
  /** Stripe PaymentIntent id, when the card channel recorded one — the key to find it in the Stripe dashboard. */
  stripePaymentIntent: string | null;
  createdAt: string;
  paidAt: string | null;
}

/* The same rule the dashboard uses (admin-stats.ts), so the two agree. */
const ORDER_METHOD_SQL = `
  CASE WHEN o.payment_method = 'stablecoin' THEN COALESCE(
    (SELECT q.token_key FROM stablecoin_intents i JOIN stablecoin_quotes q ON q.id = i.quote_id
      WHERE i.order_id = o.id AND i.state = 'confirmed' ORDER BY i.created_at DESC LIMIT 1),
    (SELECT q2.token_key FROM stablecoin_quotes q2 WHERE q2.order_id = o.id ORDER BY q2.created_at DESC LIMIT 1),
    'jpyc')
  ELSE 'card' END`;

export async function listOrdersForConsole(params: {
  status?: string;
  method?: ConsolePaymentMethod;
  email?: string;
  /** UTC instants. */
  from?: Date;
  to?: Date;
  before?: Date;
  limit?: number;
}): Promise<{ items: ConsoleOrderRow[]; more: boolean }> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
  const where: string[] = ['1 = 1'];
  const args: unknown[] = [];
  if (params.status) {
    where.push('o.status = ?');
    args.push(params.status);
  }
  if (params.email) {
    where.push('u.email_active LIKE ?');
    args.push(`${escapeLike(params.email.trim().toLowerCase())}%`);
  }
  if (params.from) {
    where.push('o.created_at >= ?');
    args.push(params.from);
  }
  if (params.to) {
    where.push('o.created_at < ?');
    args.push(params.to);
  }
  if (params.before) {
    where.push('o.created_at < ?');
    args.push(params.before);
  }
  const methodFilter = params.method ? 'HAVING method = ?' : '';
  if (params.method) args.push(params.method);
  args.push(limit + 1);

  const rows = await query<{
    id: string;
    user_id: string;
    email: string;
    price_key: string;
    kind: string;
    method: string;
    amount_minor: number;
    refunded_amount_minor: number;
    currency: string;
    status: string;
    held_for_review: number;
    entitlement_granted_at: Date | null;
    pi: string | null;
    created_at: Date;
    paid_at: Date | null;
  }>(
    `SELECT o.id, o.user_id, u.email, o.price_key, o.kind, ${ORDER_METHOD_SQL} AS method,
            o.amount_minor, o.refunded_amount_minor, o.currency, o.status,
            EXISTS (SELECT 1 FROM order_reviews r WHERE r.order_id = o.id AND r.decided_at IS NULL) AS held_for_review,
            o.entitlement_granted_at, o.created_at, o.paid_at,
            (SELECT p.stripe_object_id FROM payments p WHERE p.order_id = o.id AND p.kind = 'payment'
              ORDER BY p.occurred_at DESC LIMIT 1) AS pi
       FROM orders o JOIN users u ON u.id = o.user_id
      WHERE ${where.join(' AND ')}
      ${methodFilter}
      ORDER BY o.created_at DESC
      LIMIT ?`,
    args,
  );
  return {
    more: rows.length > limit,
    items: rows.slice(0, limit).map((r) => ({
      orderId: r.id,
      userId: r.user_id,
      email: r.email,
      priceKey: r.price_key,
      kind: r.kind,
      method: paymentMethodOf(r.method),
      amountMinor: Number(r.amount_minor),
      refundedMinor: Number(r.refunded_amount_minor ?? 0),
      currency: r.currency,
      status: r.status,
      heldForReview: Boolean(r.held_for_review),
      entitlementGranted: r.entitlement_granted_at !== null,
      stripePaymentIntent: r.pi && r.pi.startsWith('pi_') ? r.pi : null,
      createdAt: r.created_at.toISOString(),
      paidAt: r.paid_at?.toISOString() ?? null,
    })),
  };
}

export interface ConsoleAuditRow {
  id: string;
  action: string;
  actorId: string | null;
  actorEmail: string | null;
  actorRole: string;
  subjectType: string;
  subjectId: string;
  /** For a `user` subject, the account's address; null for anything else. */
  subjectEmail: string | null;
  reason: string;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export async function listAuditForConsole(params: {
  /** Prefix of the action, e.g. `user.` for every account change. */
  action?: string;
  /** Rows whose actor or user subject has this address prefix. */
  email?: string | undefined;
  /** Only rows about this one account. */
  subjectUserId?: string;
  before?: Date;
  limit?: number;
}): Promise<{ items: ConsoleAuditRow[]; more: boolean }> {
  const limit = Math.min(Math.max(params.limit ?? 100, 1), 200);
  const where: string[] = ['1 = 1'];
  const args: unknown[] = [];
  if (params.action) {
    where.push('a.action LIKE ?');
    args.push(`${escapeLike(params.action)}%`);
  }
  if (params.email) {
    const needle = `${escapeLike(params.email.trim().toLowerCase())}%`;
    where.push('(actor.email_active LIKE ? OR subj.email_active LIKE ?)');
    args.push(needle, needle);
  }
  if (params.subjectUserId) {
    where.push(`a.subject_type = 'user' AND a.subject_id = ?`);
    args.push(params.subjectUserId);
  }
  if (params.before) {
    where.push('a.created_at < ?');
    args.push(params.before);
  }
  args.push(limit + 1);
  const rows = await query<{
    id: string;
    action: string;
    actor_id: string | null;
    actor_email: string | null;
    actor_role: string;
    subject_type: string;
    subject_id: string;
    subject_email: string | null;
    reason: string;
    before_state: unknown;
    after_state: unknown;
    created_at: Date;
  }>(
    `SELECT a.id, a.action, a.actor_id, actor.email AS actor_email, a.actor_role, a.subject_type,
            a.subject_id, subj.email AS subject_email, a.reason, a.before_state, a.after_state, a.created_at
       FROM audit_logs a
       LEFT JOIN users actor ON actor.id = a.actor_id
       LEFT JOIN users subj ON a.subject_type = 'user' AND subj.id = a.subject_id
      WHERE ${where.join(' AND ')}
      ORDER BY a.created_at DESC
      LIMIT ?`,
    args,
  );
  return {
    more: rows.length > limit,
    items: rows.slice(0, limit).map((r) => ({
      id: r.id,
      action: r.action,
      actorId: r.actor_id,
      actorEmail: r.actor_email,
      actorRole: r.actor_role,
      subjectType: r.subject_type,
      subjectId: r.subject_id,
      subjectEmail: r.subject_email,
      reason: r.reason,
      before: r.before_state,
      after: r.after_state,
      createdAt: r.created_at.toISOString(),
    })),
  };
}
