import { createHmac } from 'node:crypto';
import { execute, query } from '@yuha/db';
import type { AppContext } from '../context.js';

/**
 * The notices that tell somebody their account was used or changed.
 *
 * One of the fraud measures a payment processor asks about, and the one this
 * product claimed without having any way to send mail at all. The capability
 * is `ctx.email`; this is what it is for.
 *
 * Three rules shape all of it:
 *
 * A notice on every sign-in is noise, and noise is how a real warning gets
 * missed — so only a source not seen before raises one.
 *
 * The address is never stored. `known_sign_in_sources` holds an HMAC under a
 * server secret, which answers "seen before?" and nothing else. The email
 * names the address, because it goes to the one person entitled to know it.
 *
 * Nothing here is allowed to fail the thing it describes. A sign-in that
 * happened, happened; a notice that could not be sent is logged and the
 * request continues. `ctx.email.send` already refuses to throw, and these
 * functions add their own guard for everything around it.
 */

/** Structured JSON, the same shape the rest of the system logs in. */
function log(fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ level: 'warn', component: 'notices', ts: new Date().toISOString(), ...fields }));
}

export interface SignInContext {
  userId: string;
  email: string;
  /** The client address, as Fastify resolved it through the proxy chain. */
  ip: string;
  userAgent: string | null;
  at: Date;
}

/** Keyed on a server secret so the table is useless to a reader without it. */
function sourceHash(ctx: AppContext, params: { ip: string; userAgent: string | null }): string {
  const secret = ctx.config.STORAGE_SIGNING_SECRET ?? ctx.config.DEV_AUTH_SECRET ?? 'yuha-sign-in-source';
  return createHmac('sha256', secret).update(`${params.ip}|${params.userAgent ?? ''}`).digest('hex');
}

/**
 * Records the source and says whether it was new.
 *
 * An account's very first sign-in is not "unfamiliar" — there is nothing to be
 * unfamiliar with, and warning someone about the act they are performing right
 * now teaches them to ignore the next one. So the first recorded source is
 * remembered silently.
 */
async function rememberSource(ctx: AppContext, params: SignInContext): Promise<{ firstEver: boolean; isNew: boolean }> {
  const hash = sourceHash(ctx, params);
  const seen = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM known_sign_in_sources WHERE user_id = ?`,
    [params.userId],
  );
  const known = await query<{ n: number }>(
    `SELECT COUNT(*) AS n FROM known_sign_in_sources WHERE user_id = ? AND source_hash = ?`,
    [params.userId, hash],
  );
  await execute(
    `INSERT INTO known_sign_in_sources (user_id, source_hash) VALUES (?, ?)
       ON DUPLICATE KEY UPDATE last_seen = UTC_TIMESTAMP(3)`,
    [params.userId, hash],
  );
  const firstEver = Number(seen[0]?.n ?? 0) === 0;
  return { firstEver, isNew: Number(known[0]?.n ?? 0) === 0 && !firstEver };
}

/**
 * Both languages, in one body.
 *
 * `users` records no locale — the UI language is chosen in the browser and
 * never reaches the server — so there is nothing to select on. Japanese is the
 * launch market and the language of the statutory pages; English is the
 * fallback anyone can act on. Guessing from an address would be inventing a
 * fact the database does not hold. A stored locale is the real fix and is in
 * the follow-up note.
 */
function bilingual(ja: string, en: string): string {
  return `${ja}\n\n----\n\n${en}\n`;
}

function when(at: Date): string {
  return `${at.toISOString().replace('T', ' ').slice(0, 19)} UTC`;
}

export async function noticeSignIn(ctx: AppContext, params: SignInContext): Promise<void> {
  try {
    const { isNew } = await rememberSource(ctx, params);
    if (!isNew) return;
    await ctx.email.send({
      to: params.email,
      subject: '[YUHA] 新しい場所からのサインイン / New sign-in',
      text: bilingual(
        [
          'YUHA のアカウントに、これまでと異なる場所からサインインがありました。',
          '',
          `日時: ${when(params.at)}`,
          `IP アドレス: ${params.ip}`,
          `ブラウザ: ${params.userAgent ?? '(不明)'}`,
          '',
          'お心当たりがある場合、対応は不要です。',
          '心当たりがない場合は、二要素認証の有効化をご検討ください。',
        ].join('\n'),
        [
          'Your YUHA account was signed into from somewhere we have not seen before.',
          '',
          `Time: ${when(params.at)}`,
          `IP address: ${params.ip}`,
          `Browser: ${params.userAgent ?? '(unknown)'}`,
          '',
          'If this was you, there is nothing to do.',
          'If it was not, consider turning on two-factor authentication.',
        ].join('\n'),
      ),
    });
  } catch (err) {
    // A sign-in that happened, happened. Never fail it over a notice.
    log({ msg: 'sign_in_notice_failed', userId: params.userId, error: (err as Error).message });
  }
}

export type AccountChange = 'mfa_enabled' | 'mfa_disabled' | 'deletion_requested';

const CHANGE_TEXT: Record<AccountChange, { ja: string; en: string }> = {
  mfa_enabled: {
    ja: 'YUHA のアカウントで二要素認証が有効になりました。',
    en: 'Two-factor authentication was turned on for your YUHA account.',
  },
  mfa_disabled: {
    ja: 'YUHA のアカウントで二要素認証が無効になりました。',
    en: 'Two-factor authentication was turned off for your YUHA account.',
  },
  deletion_requested: {
    ja: 'YUHA のアカウント削除がリクエストされました。',
    en: 'Deletion of your YUHA account was requested.',
  },
};

/**
 * Account changes always notify — unlike a sign-in, there is no such thing as
 * a routine one, and the whole value is that the person finds out when it was
 * not them who did it.
 */
export async function noticeAccountChange(
  ctx: AppContext,
  params: { email: string; change: AccountChange; at: Date },
): Promise<void> {
  try {
    const t = CHANGE_TEXT[params.change];
    await ctx.email.send({
      to: params.email,
      subject: '[YUHA] アカウント設定の変更 / Account change',
      text: bilingual(
        `${t.ja}\n\n日時: ${when(params.at)}\n\nお心当たりがない場合は、お問い合わせください。`,
        `${t.en}\n\nTime: ${when(params.at)}\n\nIf this was not you, please get in touch.`,
      ),
    });
  } catch (err) {
    log({ msg: 'account_change_notice_failed', change: params.change, error: (err as Error).message });
  }
}
