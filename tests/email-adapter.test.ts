/**
 * The product's ability to send email at all.
 *
 * It had none. That is why it could not tell anyone their account had been
 * signed into or changed — a fraud measure this business has declared to its
 * payment processor, and the one easiest to claim and hardest to notice
 * missing, because nothing fails when it is absent.
 *
 * Two things are pinned here, and both are about not lying. The `log` adapter
 * says it delivered nothing, because a caller that reads "sent" as "the person
 * knows" would be making exactly the mistake this seam exists to prevent. And
 * a mail server that is down must not take down the sign-in it was describing:
 * the notice reports failure, it does not throw it onward.
 *
 * No database: adapters and `loadConfig`.
 */
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '@yuha/api';
import { LogEmailAdapter, SmtpEmailAdapter } from '@yuha/providers';

const message = { to: 'someone@example.test', subject: 'サインインの通知', text: 'Tokyo, 2026-10-05 21:14' };

describe('the log adapter', () => {
  it('says plainly that it delivered nothing', async () => {
    const res = await new LogEmailAdapter(() => {}).send(message);
    expect(res.delivered).toBe(false);
    expect(res.id).toBeNull();
  });

  it('logs who and what, but never the body', async () => {
    // A sign-in notice names a place and a time, and the log is read by more
    // people than the inbox is.
    const lines: Array<Record<string, unknown>> = [];
    await new LogEmailAdapter((l) => lines.push(l)).send(message);

    expect(lines).toHaveLength(1);
    expect(lines[0]!['to']).toBe(message.to);
    expect(lines[0]!['subject']).toBe(message.subject);
    expect(JSON.stringify(lines[0])).not.toContain('Tokyo');
  });
});

describe('the smtp adapter when the mail server is not there', () => {
  const adapter = (log: (l: Record<string, unknown>) => void) =>
    new SmtpEmailAdapter(
      {
        // Reserved by RFC 6761 for exactly this: it resolves nowhere.
        host: 'mail.invalid',
        port: 587,
        secure: false,
        user: 'u',
        pass: 'p',
        from: 'YUHA <no-reply@yuha.studio>',
        timeoutMs: 1_000,
      },
      log,
    );

  it('reports the failure instead of throwing it at the caller', async () => {
    // The thing the notice describes has already happened. Failing here would
    // turn "we could not warn you" into "you could not sign in".
    const res = await adapter(() => {}).send(message);
    expect(res.delivered).toBe(false);
    expect(res.id).toBeNull();
  });

  it('leaves a reason in the log', async () => {
    const lines: Array<Record<string, unknown>> = [];
    await adapter((l) => lines.push(l)).send(message);
    expect(lines).toHaveLength(1);
    expect(lines[0]!['event']).toBe('email_send_failed');
    expect(String(lines[0]!['error'])).not.toHaveLength(0);
  });
});

describe('what production will and will not start with', () => {
  const base = {
    DATABASE_URL: 'mysql://u:p@localhost:3306/x',
    LEGAL_ENTITY_NAME: 'テスト株式会社',
    LEGAL_ENTITY_ADDRESS: '東京都渋谷区1-1-1',
    LEGAL_ENTITY_CONTACT: 'support@example.test',
    DATABASE_SSL: 'true',
  };

  it('refuses the log adapter, which delivers nothing', () => {
    // The same rule as the fake music adapter: a declared capability that
    // cannot act is worse than an absent one, because it reports success.
    expect(() => loadConfig({ ...base, RUN_MODE: 'production', EMAIL_ADAPTER: 'log' } as never))
      .toThrow(/log email adapter/);
  });

  it('refuses an smtp adapter with nowhere to send and nobody to send as', () => {
    for (const missing of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM'] as const) {
      const env: Record<string, string> = {
        ...base,
        RUN_MODE: 'integration',
        EMAIL_ADAPTER: 'smtp',
        SMTP_HOST: 'smtp.example.test',
        SMTP_USER: 'u',
        SMTP_PASS: 'p',
        EMAIL_FROM: 'YUHA <no-reply@yuha.studio>',
      };
      delete env[missing];
      expect(() => loadConfig(env as never), missing).toThrow(ConfigError);
    }
  });

  it('leaves the office and demo builds unable to email anybody by accident', () => {
    // Eight colleagues test the office build. None of them should get mail
    // from it, and a deploy should not need an email account to start.
    // Those two modes also need their own dev secrets to start at all; they
    // are here so this asserts the email default rather than tripping on them.
    const dev = { ...base, DEV_AUTH_SECRET: 'x'.repeat(32), STORAGE_SIGNING_SECRET: 'y'.repeat(32) };
    expect(loadConfig({ ...dev, RUN_MODE: 'demo' } as never).adapters.email).toBe('log');
    expect(loadConfig({ ...dev, RUN_MODE: 'integration' } as never).adapters.email).toBe('log');
  });
});
