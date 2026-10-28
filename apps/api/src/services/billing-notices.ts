import { claimCustomerNotice, getUser } from '@yuha/db';
import type { AppContext } from '../context.js';

/**
 * Telling a customer what happened to their money and their plan.
 *
 * A subscriber reported, after being refunded and having the plan cancelled,
 * that neither arrived as a notice: the only mail they had was the payment
 * receipt. So three moments now send one email each:
 *
 *  - a refund, when it is recorded (`noticeRefund`);
 *  - a subscription set to end at the close of its period (`noticeCancelScheduled`),
 *    whether that was asked for here, in Stripe's portal or by an operator;
 *  - a subscription that has ended (`noticeSubscriptionEnded`).
 *
 * Each is claimed once in `customer_notices` before it is sent, because Stripe
 * delivers events at least once and describes one refund in two events.
 *
 * Three languages in one body. `users` records no locale (notices.ts says
 * why), and these customers read Japanese, Chinese and English, so all three
 * are given, Japanese first as the market of record. Dates are Tokyo dates,
 * the calendar the plan and the receipts use.
 *
 * Nothing here may fail the thing it reports. A refund recorded is recorded;
 * a notice that could not be sent is logged.
 */
function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'warn', component: 'billing_notices', ts: new Date().toISOString(), ...fields }));
}

function trilingual(ja: string, zh: string, en: string): string {
  return `${ja}\n\n----\n\n${zh}\n\n----\n\n${en}\n`;
}

/** 2026-11-20, as a date in Tokyo. */
function tokyoDate(at: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/** ¥1,980 for yen (no minor unit); otherwise the amount in major units and the code. */
function money(minor: number, currency: string): string {
  const c = currency.toLowerCase();
  if (c === 'jpy') return `¥${minor.toLocaleString('en-US')}`;
  return `${(minor / 100).toFixed(2)} ${c.toUpperCase()}`;
}

/** Claims, then sends to the account's address. Skips a deleted account, whose address is no longer theirs. */
async function sendOnce(
  ctx: AppContext,
  params: { userId: string; kind: string; ref: string; subject: string; text: string },
): Promise<void> {
  try {
    const user = await getUser(params.userId);
    if (!user || user.status === 'deleted' || user.deleted_at) return;
    if (!(await claimCustomerNotice({ userId: params.userId, kind: params.kind, ref: params.ref }))) return;
    await ctx.email.send({ to: user.email, subject: params.subject, text: params.text });
  } catch (err) {
    log({ msg: 'billing_notice_failed', kind: params.kind, userId: params.userId, error: (err as Error).message });
  }
}

export async function noticeRefund(
  ctx: AppContext,
  params: { userId: string; ref: string; amountMinor: number; totalRefundedMinor: number; paidMinor: number; currency: string },
): Promise<void> {
  const amount = money(params.amountMinor, params.currency);
  const total = money(params.totalRefundedMinor, params.currency);
  const paid = money(params.paidMinor, params.currency);
  const full = params.totalRefundedMinor >= params.paidMinor;
  await sendOnce(ctx, {
    userId: params.userId,
    kind: 'refund',
    ref: params.ref,
    subject: '[YUHA] 返金のお知らせ / 退款通知 / Refund issued',
    text: trilingual(
      [
        `YUHA でのお支払い（${paid}）について、${amount} の返金を行いました。`,
        full ? 'これでお支払いの全額が返金されました。' : `これまでの返金額の合計は ${total} です。`,
        '',
        'カードへの反映には、カード会社により数日から数週間かかることがあります。',
        '返金に伴い、未使用の回数は取り消されています。',
      ].join('\n'),
      [
        `您在 YUHA 的付款（${paid}）已退款 ${amount}。`,
        full ? '付款已全额退还。' : `目前累计退款 ${total}。`,
        '',
        '退款到账时间取决于发卡机构，一般需要几天到几周。',
        '退款后，尚未使用的额度已相应取消。',
      ].join('\n'),
      [
        `We have refunded ${amount} of your YUHA payment (${paid}).`,
        full ? 'Your payment has now been refunded in full.' : `Refunded so far: ${total}.`,
        '',
        'Depending on your card issuer, it can take a few days to a few weeks to appear.',
        'Unused credits from that payment have been withdrawn.',
      ].join('\n'),
    ),
  });
}

export async function noticeCancelScheduled(
  ctx: AppContext,
  params: { userId: string; subscriptionId: string; periodEnd: Date | null },
): Promise<void> {
  const until = params.periodEnd ? tokyoDate(params.periodEnd) : null;
  await sendOnce(ctx, {
    userId: params.userId,
    kind: 'subscription_cancel_scheduled',
    ref: `${params.subscriptionId}:${until ?? 'now'}`,
    subject: '[YUHA] サブスクリプション解約のお知らせ / 订阅取消通知 / Subscription cancelled',
    text: trilingual(
      [
        'YUHA のサブスクリプションの解約を受け付けました。',
        until ? `${until}（日本時間）まで引き続きご利用いただけ、それ以降の請求は発生しません。` : 'これ以降の請求は発生しません。',
        '',
        'お心当たりがない場合は、お問い合わせください。',
      ].join('\n'),
      [
        '您的 YUHA 订阅已取消。',
        until ? `在 ${until}（东京时间）之前仍可正常使用，此后不会再扣费。` : '此后不会再扣费。',
        '',
        '如果这不是您本人的操作，请与我们联系。',
      ].join('\n'),
      [
        'Your YUHA subscription has been cancelled.',
        until ? `You keep it until ${until} (Tokyo time), and you will not be charged again.` : 'You will not be charged again.',
        '',
        'If this was not you, please get in touch.',
      ].join('\n'),
    ),
  });
}

export async function noticeSubscriptionEnded(
  ctx: AppContext,
  params: { userId: string; subscriptionId: string },
): Promise<void> {
  await sendOnce(ctx, {
    userId: params.userId,
    kind: 'subscription_ended',
    ref: params.subscriptionId,
    subject: '[YUHA] サブスクリプション終了のお知らせ / 订阅已结束 / Subscription ended',
    text: trilingual(
      [
        'YUHA のサブスクリプションが終了しました。今後の請求はありません。',
        'これまでに作成した曲は、引き続き「マイ作品」でご覧いただけます。',
      ].join('\n'),
      ['您的 YUHA 订阅已结束，之后不会再扣费。', '已经创作的歌曲仍可在「我的作品」中查看。'].join('\n'),
      [
        'Your YUHA subscription has ended. You will not be charged again.',
        'The songs you made are still in My songs.',
      ].join('\n'),
    ),
  });
}
