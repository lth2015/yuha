/**
 * Telling somebody their account was used or changed.
 *
 * The fraud measure this product declared to its payment processor and did not
 * have. What makes it worth testing rather than eyeballing is that every
 * failure mode here is silent: a notice that is never sent looks exactly like
 * one that was not needed, and a notice sent on every sign-in trains people to
 * ignore the one that matters.
 *
 * So four claims are pinned. A familiar source is quiet. An unfamiliar one is
 * not. The address reaches the person and not the database. And none of it can
 * fail the sign-in it describes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '@yuha/db';
import type { EmailAdapter, EmailMessage, EmailResult } from '@yuha/providers';
import { createHarness, resetData, teardown, type Harness } from './helpers/harness.js';

/** Records what would have gone out, and can be told to fail. */
class RecordingEmail implements EmailAdapter {
  readonly kind = 'log' as const;
  sent: EmailMessage[] = [];
  throwOnSend = false;

  async send(message: EmailMessage): Promise<EmailResult> {
    if (this.throwOnSend) throw new Error('mail server is on fire');
    this.sent.push(message);
    return { delivered: true, id: 'test' };
  }
}

let h: Harness;
let mail: RecordingEmail;

beforeAll(async () => {
  h = await createHarness();
});

beforeEach(async () => {
  /*
   * Let the previous test's in-flight notices land before truncating.
   *
   * The route does not await the notice — a sign-in must not wait on mail —
   * so a request can still be writing its source row after the test that made
   * it has finished. Resetting first and settling second leaves that write to
   * arrive into the next test's clean table, which showed up here as a count
   * of three where two were expected. The looseness is in the test, not in the
   * product: production has no truncate to race with.
   */
  await new Promise((r) => setTimeout(r, 150));
  await resetData();
  mail = new RecordingEmail();
  h.ctx.email = mail;
});

afterAll(async () => {
  await teardown(h);
});

/**
 * Waits for a notice to arrive.
 *
 * The send is deliberately not awaited in the route — a notice must never
 * delay or fail the sign-in it describes — so asserting immediately after the
 * response is asserting a race. Two of these tests passed that way for a while
 * purely because they made one more request before looking.
 */
async function waitForMail(count: number, within = 2_000): Promise<void> {
  const until = Date.now() + within;
  while (mail.sent.length < count && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Nothing should arrive. Give it the same budget before believing that. */
async function settle(within = 300): Promise<void> {
  await new Promise((r) => setTimeout(r, within));
}

const signIn = (email: string, from: { ip: string; agent?: string }) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/auth/dev-login',
    headers: {
      'x-forwarded-for': from.ip,
      'user-agent': from.agent ?? 'Mozilla/5.0 (Macintosh)',
    },
    payload: { email, ageConfirmed: true, termsAccepted: true } as never,
  });

describe('a sign-in from somewhere new', () => {
  it('says nothing about the very first one', async () => {
    // There is nothing to be unfamiliar with yet, and warning someone about
    // the act they are performing right now teaches them to ignore the next.
    const res = await signIn('first@example.jp', { ip: '203.0.113.10' });
    expect(res.statusCode).toBe(200);
    await settle();
    expect(mail.sent).toHaveLength(0);
  });

  it('stays quiet when the same person comes back from the same place', async () => {
    await signIn('same@example.jp', { ip: '203.0.113.10' });
    await signIn('same@example.jp', { ip: '203.0.113.10' });
    await signIn('same@example.jp', { ip: '203.0.113.10' });
    await settle();
    expect(mail.sent).toHaveLength(0);
  });

  it('writes once when the place changes', async () => {
    await signIn('moved@example.jp', { ip: '203.0.113.10' });
    await signIn('moved@example.jp', { ip: '198.51.100.7' });

    await waitForMail(1);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toBe('moved@example.jp');
    expect(mail.sent[0]!.subject).toContain('New sign-in');
  });

  it('counts a different browser from the same address as somewhere new', async () => {
    await signIn('ua@example.jp', { ip: '203.0.113.10', agent: 'Mozilla/5.0 (Macintosh)' });
    await signIn('ua@example.jp', { ip: '203.0.113.10', agent: 'Mozilla/5.0 (Windows)' });
    await waitForMail(1);
    expect(mail.sent).toHaveLength(1);
  });

  it('does not warn twice about a place it has now seen', async () => {
    await signIn('twice@example.jp', { ip: '203.0.113.10' });
    await signIn('twice@example.jp', { ip: '198.51.100.7' });
    await signIn('twice@example.jp', { ip: '198.51.100.7' });
    await waitForMail(1);
    await settle();
    expect(mail.sent).toHaveLength(1);
  });
});

describe('what the person gets and what the database keeps', () => {
  it('names the address in the email', async () => {
    await signIn('addr@example.jp', { ip: '203.0.113.10' });
    await signIn('addr@example.jp', { ip: '198.51.100.7' });
    await waitForMail(1);
    expect(mail.sent[0]!.text).toContain('198.51.100.7');
  });

  it('keeps no address in the database, only something to recognise it by', async () => {
    // The email goes to the one person entitled to know where they signed in
    // from. The table is read by more people than that, so it holds an HMAC
    // and cannot be turned back into an address.
    await signIn('priv@example.jp', { ip: '203.0.113.10' });
    await settle();
    const rows = await query<{ source_hash: string }>(`SELECT source_hash FROM known_sign_in_sources`);
    expect(rows).not.toHaveLength(0);
    for (const row of rows) {
      expect(row.source_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(row.source_hash).not.toContain('203.0.113');
    }
  });

  it('writes in both languages, because the server is never told which one', async () => {
    await signIn('lang@example.jp', { ip: '203.0.113.10' });
    await signIn('lang@example.jp', { ip: '198.51.100.7' });
    await waitForMail(1);
    expect(mail.sent[0]!.text).toContain('サインイン');
    expect(mail.sent[0]!.text).toContain('sign');
  });
});

describe('when the mail server is down', () => {
  it('lets the sign-in through anyway', async () => {
    // The sign-in has already happened. Failing it here would turn "we could
    // not warn you" into "you could not get in".
    await signIn('down@example.jp', { ip: '203.0.113.10' });
    mail.throwOnSend = true;

    const res = await signIn('down@example.jp', { ip: '198.51.100.7' });
    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTruthy();
  });

  it('still remembers the place, so the next visit from it is not a surprise', async () => {
    await signIn('mem@example.jp', { ip: '203.0.113.10' });
    mail.throwOnSend = true;
    await signIn('mem@example.jp', { ip: '198.51.100.7' });
    await settle();

    const rows = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM known_sign_in_sources`,
    );
    expect(Number(rows[0]!.n)).toBe(2);
  });
});

describe('account changes always say so', () => {
  it('tells the owner when a second factor is turned on, and when it is turned off', async () => {
    const user = await h.createUser({ email: 'mfa@example.jp' });

    const enroll = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/enroll',
      headers: user.authHeader,
    });
    expect(enroll.statusCode).toBe(200);
    // Enrolling is not a change yet — the factor is inactive until confirmed.
    await settle();
    expect(mail.sent).toHaveLength(0);
  });

  it('tells the owner when deletion is requested, once', async () => {
    const user = await h.createUser({ email: 'del@example.jp' });

    const first = await h.app.inject({
      method: 'POST',
      url: '/v1/me/deletion-request',
      headers: user.authHeader,
      payload: {} as never,
    });
    expect(first.statusCode).toBeLessThan(300);

    // Asking twice returns the first ticket; a second notice would read as a
    // second deletion.
    await h.app.inject({
      method: 'POST',
      url: '/v1/me/deletion-request',
      headers: user.authHeader,
      payload: {} as never,
    });

    await waitForMail(1);
    await settle();
    const notices = mail.sent.filter((m) => m.subject.includes('Account change'));
    expect(notices).toHaveLength(1);
    expect(notices[0]!.text).toContain('削除');
  });
});
