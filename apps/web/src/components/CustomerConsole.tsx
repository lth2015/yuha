import { useCallback, useState } from 'react';
import { apiFetch } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { formatJst, formatMoney, useSession } from '../lib/session';
import { LOCALES } from '../lib/money';
import { mayDecidePayments } from '../lib/stablecoin';
import { Badge, ErrorNotice } from './common';
import { AccountControls } from './admin/AccountControls';

/**
 * Finding a customer, and giving them credits.
 *
 * Neither existed. The only route that granted units took a user UUID in its
 * path, had no interface anywhere, and nothing in the product could turn an
 * email address into that UUID — so "give my friend fifty credits" meant
 * opening a SQL client. `services/purchase-cap.ts` meanwhile reassured the
 * reader that an operator could "issue credits directly from the console",
 * which was the escape hatch it offered as a reason not to worry about the
 * purchase cap, and it was not there.
 *
 * Three things this screen shows that a single balance number would hide, and
 * each one changes the decision an operator is about to make: where the
 * existing credits came from, when they expire, and what the account has
 * bought. Someone holding forty credits that expire on Friday does not need
 * fifty more; someone whose last batch was a compensation may be owed an
 * apology rather than a gift.
 *
 * Gifting is admin-only and compensation is not, on purpose: a credit is a
 * generation and a generation is provider cost, so this screen spends money.
 */

interface Found {
  userId: string;
  email: string;
  displayName: string | null;
  role: string;
  status: string;
  createdAt: string;
  available: number;
}

interface Detail {
  userId: string;
  email: string;
  displayName: string | null;
  role: string;
  status: string;
  createdAt: string;
  balance: { available: number; reserved: number; consumed: number; granted: number };
  creditsTruncated: boolean;
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
  recentJobs?: Array<{
    jobId: string;
    state: string;
    errorCode: string | null;
    trackId: string | null;
    createdAt: string;
    /** The ledger's answer, the same one the owner sees (docs/FAILURE_COMPENSATION_SPEC.md). */
    credit: 'held' | 'spent' | 'returned' | 'compensated' | 'none';
  }>;
  activity?: Array<{ action: string; actorEmail: string | null; reason: string; createdAt: string }>;
}

interface GiftDone {
  units: number;
  expiresAt: string;
  remainingToday: number;
  /** True when the key matched an earlier gift and nothing new was written. */
  replayed?: boolean;
}

/** At least 8 characters, which is what the route's schema requires. */
function newAttemptKey(): string {
  return `gift-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function CustomerConsole() {
  const { t, lang } = useI18n();
  const { me, refreshEntitlements } = useSession();
  const [email, setEmail] = useState('');
  const [found, setFound] = useState<{ items: Found[]; more: boolean } | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [units, setUnits] = useState('');
  const [reason, setReason] = useState('');
  const [done, setDone] = useState<GiftDone | null>(null);
  /*
   * One key per attempt, generated when the form is ready rather than when the
   * request is sent.
   *
   * This is what makes a retry a retry. The API commits, the response is lost
   * to an idle timeout or a pod roll, and the operator — who sees an error
   * beside the pre-gift balance — presses again. With the same key that is one
   * gift; without one it was two, and two audit rows that both look
   * deliberate. The key is replaced only after a gift lands, so every press of
   * this button until then is the same attempt.
   */
  const [attemptKey, setAttemptKey] = useState(() => newAttemptKey());

  const mayGift = mayDecidePayments(me?.role);

  const search = useCallback(async () => {
    const q = email.trim();
    if (q.length < 3) return;
    setBusy(true);
    setError(null);
    setDetail(null);
    setDone(null);
    try {
      setFound(
        await apiFetch<{ items: Found[]; more: boolean }>(
          `/v1/admin/users?email=${encodeURIComponent(q)}`,
        ),
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  }, [email]);

  const open = async (userId: string) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setDetail(await apiFetch<Detail>(`/v1/admin/users/${userId}`));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  /** Re-read the open record and keep the search row's figures in step. */
  const refresh = async () => {
    if (!detail) return;
    const fresh = await apiFetch<Detail>(`/v1/admin/users/${detail.userId}`);
    setDetail(fresh);
    if (fresh.userId === me?.userId) void refreshEntitlements();
    setFound((f) =>
      f
        ? {
            ...f,
            items: f.items.map((u) =>
              u.userId === fresh.userId ? { ...u, available: fresh.balance.available, status: fresh.status, role: fresh.role } : u,
            ),
          }
        : f,
    );
  };

  /**
   * One credit back for one generation (docs/FAILURE_COMPENSATION_SPEC.md),
   * through the existing compensation route with the job attached, so the
   * ledger allows it once per job and the owner's history links it to the song.
   */
  const [compensating, setCompensating] = useState<string | null>(null);
  const compensate = async (jobId: string) => {
    if (!detail) return;
    const why = window.prompt(t('admin.cust.jobs.compensatePrompt'));
    if (!why || why.trim().length < 5) return;
    setCompensating(jobId);
    setError(null);
    try {
      const res = await apiFetch<{ created: boolean }>(`/v1/admin/users/${detail.userId}/compensate`, {
        method: 'POST',
        body: { units: 1, jobId, reason: why.trim() },
      });
      if (!res.created) window.alert(t('admin.cust.jobs.alreadyCompensated'));
      await refresh();
    } catch (err) {
      setError(err);
    } finally {
      setCompensating(null);
    }
  };

  const gift = async () => {
    if (!detail || !mayGift) return;
    /*
     * Parsed strictly rather than with `Number`, which accepts `1e3`, ` 50 `,
     * `+50` and `-0` and silently turns `50.5` into a value the server then
     * rejects. A number input can hold any of those: the browser only
     * validates on form submit, and this is a button rather than a submit.
     */
    const n = /^\d+$/.test(units.trim()) ? Number(units.trim()) : NaN;
    if (!Number.isInteger(n) || n < 1) return;
    if (reason.trim().length < 5) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<GiftDone>(`/v1/admin/users/${detail.userId}/grant`, {
        method: 'POST',
        body: { units: n, reason: reason.trim(), idempotencyKey: attemptKey },
      });
      setUnits('');
      setReason('');
      // A new key: the next gift is a new decision, not a retry of this one.
      setAttemptKey(newAttemptKey());
      /*
       * Re-read rather than patching the number locally: the batch list, the
       * expiry and the balance all moved, and a screen showing a stale balance
       * next to "Given 50" is how somebody gifts twice.
       *
       * Which is why `done` is set only once the re-read has LANDED. Setting
       * it first and refetching second left exactly the state this comment
       * claims to prevent whenever the refetch failed: the success line
       * rendered beside the pre-gift numbers. If the re-read fails the gift
       * still happened, so the error is shown without the confirmation and
       * the operator reloads rather than being told a number that is wrong.
       */
      const fresh = await apiFetch<Detail>(`/v1/admin/users/${detail.userId}`);
      setDetail(fresh);
      setDone(res);
      // Gifting yourself moves the balance in your own header too.
      if (fresh.userId === me?.userId) void refreshEntitlements();
      // The search list carries its own `available` column, which is now a
      // screen-width away from the balance that just changed.
      setFound((f) =>
        f
          ? {
              ...f,
              items: f.items.map((u) =>
                u.userId === fresh.userId ? { ...u, available: fresh.balance.available } : u,
              ),
            }
          : f,
      );
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  // The same strictness as `gift`, so the button is not enabled for a value
  // the handler will silently drop.
  const giftReady = mayGift && /^\d+$/.test(units.trim()) && Number(units.trim()) >= 1 && reason.trim().length >= 5;

  return (
    <section className="stack">
      <h2 style={{ fontSize: 18, margin: 0 }}>{t('admin.cust.h2')}</h2>
      <p className="small muted" style={{ margin: 0 }}>
        {t('admin.cust.note')}
      </p>

      <form
        className="row search-row"
        onSubmit={(e) => {
          e.preventDefault();
          void search();
        }}
      >
        <input
          // A prefix is a valid search (the API matches `email_active LIKE
          // 'needle%'`), and `type="email"` made the browser refuse one.
          type="search"
          inputMode="email"
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={t('admin.cust.search.placeholder')}
          aria-label={t('admin.cust.search.label')}
        />
        <button type="submit" className="btn btn--ghost" disabled={busy || email.trim().length < 3}>
          {t('admin.cust.search.go')}
        </button>
      </form>

      <ErrorNotice error={error} />

      {found && found.items.length === 0 && <p className="muted small">{t('admin.cust.search.none')}</p>}
      {found && found.more && <p className="small muted">{t('admin.cust.search.more')}</p>}

      {found && found.items.length > 0 && (
        <div className="table-wrap table-wrap--stack">
          <table>
            <thead>
              <tr>
                <th>{t('admin.cust.col.email')}</th>
                <th>{t('admin.cust.col.available')}</th>
                <th className="col-wide-only">{t('admin.cust.col.joined')}</th>
                <th className="col-action" />
              </tr>
            </thead>
            <tbody>
              {found.items.map((u) => (
                <tr key={u.userId}>
                  <td className="small cell-wrap">
                    {u.email}
                    {u.status !== 'active' && (
                      <>
                        {' '}
                        <Badge tone="badge--warn">{u.status}</Badge>
                      </>
                    )}
                    <div className="small muted">{u.displayName ?? '—'}</div>
                  </td>
                  <td className="num small">{u.available}</td>
                  <td className="small muted col-wide-only">{formatJst(u.createdAt, false)}</td>
                  <td className="col-action">
                    <button type="button" className="btn btn--ghost" onClick={() => void open(u.userId)}>
                      {t('admin.cust.open')}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {detail && (
        <div className="stack" style={{ gap: 'var(--s3)' }}>
          <div className="row row--between">
            <strong className="small">{detail.email}</strong>
            <span className="small muted">
              {t('admin.cust.balance.available')}: {detail.balance.available} ·{' '}
              {t('admin.cust.balance.reserved')}: {detail.balance.reserved} ·{' '}
              {t('admin.cust.balance.consumed')}: {detail.balance.consumed}
            </span>
          </div>

          <AccountControls
            key={detail.userId}
            userId={detail.userId}
            role={detail.role}
            status={detail.status}
            isSelf={detail.userId === me?.userId}
            isAdmin={mayGift}
            onChanged={refresh}
          />

          <div className="stack" style={{ gap: 'var(--s2)' }}>
            <h3 style={{ fontSize: 15, margin: 0 }}>{t('admin.cust.credits.h3')}</h3>
            {detail.creditsTruncated && <p className="small muted">{t('admin.cust.credits.more')}</p>}
            {detail.credits.length === 0 ? (
              <p className="muted small">{t('admin.cust.credits.none')}</p>
            ) : (
              <div className="table-wrap table-wrap--stack">
                <table>
                  <thead>
                    <tr>
                      <th>{t('admin.cust.credits.col.source')}</th>
                      <th>{t('admin.cust.credits.col.units')}</th>
                      <th>{t('admin.cust.credits.col.used')}</th>
                      <th>{t('admin.cust.credits.col.expires')}</th>
                      <th>{t('admin.cust.credits.col.when')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.credits.map((b) => (
                      <tr key={b.batchId}>
                        <td className="small">
                          {t(`admin.cust.source.${b.source}`)}
                          {b.status !== 'active' && (
                            <>
                              {' '}
                              <Badge tone="badge--warn">{b.status}</Badge>
                            </>
                          )}
                        </td>
                        <td className="num small">{b.units}</td>
                        <td className="num small">{b.reserved + b.consumed}</td>
                        <td className="small muted">
                          {b.expiresAt ? formatJst(b.expiresAt, false) : t('admin.cust.credits.noExpiry')}
                        </td>
                        <td className="small muted">{formatJst(b.createdAt, false)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="stack" style={{ gap: 'var(--s2)' }}>
            <h3 style={{ fontSize: 15, margin: 0 }}>{t('admin.cust.orders.h3')}</h3>
            {detail.ordersTruncated && <p className="small muted">{t('admin.cust.orders.more')}</p>}
            {detail.orders.length === 0 ? (
              <p className="muted small">{t('admin.cust.orders.none')}</p>
            ) : (
              <div className="table-wrap table-wrap--stack">
                <table>
                  <thead>
                    <tr>
                      <th>{t('admin.cust.orders.col.what')}</th>
                      <th>{t('admin.sc.col.amount')}</th>
                      <th>{t('admin.cust.orders.col.status')}</th>
                      <th>{t('admin.cust.orders.col.when')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.orders.map((o) => (
                      <tr key={o.orderId}>
                        <td className="small">{o.priceKey}</td>
                        <td className="num small">
                          {formatMoney(o.amountMinor, o.currency, LOCALES[lang])}
                        </td>
                        <td className="small">{o.status}</td>
                        <td className="small muted">{formatJst(o.createdAt, false)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {detail.recentJobs && (
            <div className="stack" style={{ gap: 'var(--s2)' }}>
              <h3 style={{ fontSize: 15, margin: 0 }}>{t('admin.cust.jobs.h3')}</h3>
              {detail.recentJobs.length === 0 ? (
                <p className="muted small">{t('admin.cust.jobs.none')}</p>
              ) : (
                <div className="table-wrap table-wrap--stack">
                  <table>
                    <thead>
                      <tr>
                        <th>{t('admin.orders.col.when')}</th>
                        <th>{t('admin.cust.jobs.col.state')}</th>
                        <th>{t('admin.cust.jobs.col.credit')}</th>
                        <th>{t('job.ref')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.recentJobs.map((j) => (
                        <tr key={j.jobId}>
                          <td className="small muted">{formatJst(j.createdAt, true)}</td>
                          <td className="small">
                            {j.state}
                            {j.errorCode && <span className="muted"> · {j.errorCode}</span>}
                          </td>
                          <td className="small">{t(`job.credit.short.${j.credit}`)}</td>
                          {/* The id the owner quotes from their failure page, to match it here. */}
                          <td className="small" style={{ whiteSpace: 'normal', minWidth: '12ch' }}>
                            <span className="muted num" style={{ display: 'block', wordBreak: 'break-all', userSelect: 'all' }}>{j.jobId}</span>
                            <button
                              type="button"
                              className="btn btn--sm"
                              disabled={compensating === j.jobId}
                              onClick={() => void compensate(j.jobId)}
                            >
                              {t('admin.cust.jobs.compensate')}
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {detail.activity && detail.activity.length > 0 && (
            <div className="stack" style={{ gap: 'var(--s2)' }}>
              <h3 style={{ fontSize: 15, margin: 0 }}>{t('admin.cust.activity.h3')}</h3>
              <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
                {detail.activity.map((a, i) => (
                  <li key={`${a.createdAt}-${i}`}>
                    <span className="muted">{formatJst(a.createdAt, true)}</span> · <code>{a.action}</code> ·{' '}
                    {a.actorEmail ?? '—'} · {a.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="stack" style={{ gap: 'var(--s2)' }}>
            <h3 style={{ fontSize: 15, margin: 0 }}>{t('admin.cust.gift.h3')}</h3>
            <p className="small muted" style={{ margin: 0 }}>
              {t('admin.cust.gift.note')}
            </p>
            {!mayGift && <p className="small muted">{t('admin.cust.gift.adminOnly')}</p>}
            <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--s2)' }}>
              <input
                type="number"
                min={1}
                step={1}
                value={units}
                onChange={(e) => setUnits(e.target.value)}
                placeholder={t('admin.cust.gift.units')}
                aria-label={t('admin.cust.gift.units')}
                disabled={!mayGift}
                style={{ width: 110 }}
              />
              <input
                type="text"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('admin.sc.reason')}
                aria-label={t('admin.sc.reason')}
                disabled={!mayGift}
                style={{ minWidth: 240 }}
              />
              <button
                type="button"
                className="btn"
                disabled={!giftReady || busy}
                onClick={() => void gift()}
              >
                {t('admin.cust.gift.submit')}
              </button>
            </div>
            {done && (
              <p className="small" role="status">
                {done.replayed ? t('admin.cust.gift.already') : t('admin.cust.gift.done')} {done.units} ·{' '}
                {t('admin.cust.gift.expiresOn')} {formatJst(done.expiresAt, false)}
                {done.remainingToday >= 0 && (
                  <>
                    {' · '}
                    {t('admin.cust.gift.remaining')} {done.remainingToday}
                  </>
                )}
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
