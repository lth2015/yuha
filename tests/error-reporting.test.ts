/**
 * What gets written down when something throws.
 *
 * `(err as Error).message` is `undefined` for anything that is not an Error,
 * and plenty of things are not: a driver rejecting with `{ code: 'ER_...' }`,
 * a bare `throw 'ECONNRESET'`, a null. Fourteen call sites in the worker and
 * three in the webhook service used it, so a log line named a failed step and
 * said nothing about it, and a webhook row recorded a failure with no reason.
 *
 * `webhook_events.last_error` is VARCHAR(500) and `finishWebhookEvent` already
 * cut to length — but with `.slice(0, 500)`, which counts UTF-16 code units
 * and can land between the halves of a surrogate pair. The first draft of this
 * test asserted that MySQL then refuses the row. It does not: the driver
 * encodes the lone surrogate as U+FFFD and the write succeeds. The real defect
 * is smaller and still worth removing — the tail of the message becomes a
 * question mark in a diamond, in the one column whose job is saying what went
 * wrong.
 *
 * An emoji in an error message is not exotic. Any message quoting the user
 * text that caused it — a title, a prompt, a lyric — can carry one, and those
 * are exactly the messages worth keeping.
 */
import { describe, expect, it, afterAll, beforeAll, beforeEach } from 'vitest';
import { describeError } from '@yuha/contracts';
import { finishWebhookEvent, query, recordWebhookEvent } from '@yuha/db';
import { createHarness, resetData, teardown, type Harness } from './helpers/harness';

let h: Harness;
beforeAll(async () => { h = await createHarness(); });
beforeEach(async () => { await resetData(); });
afterAll(async () => { await h?.close(); await teardown(); });

describe('describing something that was thrown', () => {
  it('uses an Error message when there is one', () => {
    expect(describeError(new Error('charge disagrees with the catalogue')))
      .toBe('charge disagrees with the catalogue');
  });

  it('falls back to the name when an Error carries no message', () => {
    // `new Error()` has an empty message; "Error" at least says a throw
    // happened, where an empty string reads as nothing having gone wrong.
    expect(describeError(new Error())).toBe('Error');
    expect(describeError(new TypeError())).toBe('TypeError');
  });

  it('reports the things that are not Errors, rather than undefined', () => {
    expect(describeError('ECONNRESET')).toBe('ECONNRESET');
    expect(describeError({ code: 'ER_LOCK_DEADLOCK' })).toContain('ER_LOCK_DEADLOCK');
    expect(describeError(null)).toBe('null');
    expect(describeError(undefined)).toBe('undefined thrown');
    expect(describeError(42)).toBe('42');
  });

  it('survives a value that cannot be serialised', () => {
    // A circular object is what an ORM or a driver error often is, and a
    // reporter that throws while reporting is worse than a vague line.
    const circular: Record<string, unknown> = { code: 'ER_X' };
    circular.self = circular;
    expect(() => describeError(circular)).not.toThrow();
    expect(describeError(circular)).toBeTruthy();
  });
});

describe('recording why a webhook failed', () => {
  it('stores a message far longer than the column, instead of refusing the write', async () => {
    const { row } = await recordWebhookEvent({
      provider: 'stripe',
      eventId: 'evt_long_error',
      eventType: 'checkout.session.completed',
      signatureVerified: true,
      payload: { id: 'cs_long' },
    });

    const huge = `Error: upstream said no\n${'    at someFrame (/app/dist/x.js:1:1)\n'.repeat(80)}`;
    expect(huge.length).toBeGreaterThan(500);

    // Strict mode refuses an over-long value outright. If this throws, the row
    // stays 'processing' and the reason for the failure is lost with it.
    await expect(
      finishWebhookEvent({ id: row.id, status: 'failed', error: huge }),
    ).resolves.toBeUndefined();

    const stored = await query<{ status: string; last_error: string | null }>(
      `SELECT status, last_error FROM webhook_events WHERE id = ?`, [row.id],
    );
    expect(stored[0]!.status).toBe('failed');
    // Kept the front of it: the first line is the one that says what happened.
    expect(stored[0]!.last_error).toContain('upstream said no');
    expect([...stored[0]!.last_error!].length).toBeLessThanOrEqual(500);
  });

  it('cuts a message between characters, not through one', async () => {
    const { row } = await recordWebhookEvent({
      provider: 'stripe',
      eventId: 'evt_astral_error',
      eventType: 'checkout.session.completed',
      signatureVerified: true,
      payload: { id: 'cs_astral' },
    });

    // 499 ASCII then emoji: a cut at 500 UTF-16 units lands between the two
    // halves of the first one.
    const message = `${'x'.repeat(499)}${'\u{1F3B5}'.repeat(20)}`;
    await expect(
      finishWebhookEvent({ id: row.id, status: 'failed', error: message }),
    ).resolves.toBeUndefined();

    const stored = await query<{ last_error: string | null }>(
      `SELECT last_error FROM webhook_events WHERE id = ?`, [row.id],
    );
    const kept = stored[0]!.last_error!;
    expect(kept.startsWith('x'.repeat(499))).toBe(true);
    // No half a character survived the cut, and none was replaced by one
    // either — U+FFFD is what a split pair becomes, so asserting only "no
    // surrogate" would have passed on the broken version.
    expect(kept).not.toContain('\uFFFD');
    for (const ch of kept) {
      const cp = ch.codePointAt(0)!;
      expect(cp >= 0xd800 && cp <= 0xdfff).toBe(false);
    }
    // The cut landed on the character boundary and kept the whole character
    // that straddled it: 499 x's plus one complete emoji. VARCHAR(500) counts
    // characters, not units, so 500 code points is exactly the column.
    expect([...kept].length).toBe(500);
    expect([...kept].at(-1)).toBe('\u{1F3B5}');
  });
});
