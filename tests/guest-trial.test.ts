/**
 * Trying YUHA without an account (docs/GROWTH_SPEC.md, part three).
 *
 * A guest is a real `users` row with role 'guest', so generation, credits and
 * delivery are the code everyone else runs. What is new is the door: who may
 * open one (the switch, the device, the network, the day's total), and what a
 * guest may do once inside (make one song and look at it; nothing that buys,
 * downloads or lists).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { getBalance, queryOne } from '@yuha/db';
import { createHarness, resetData, teardown, type Harness } from './helpers/harness.js';

let on: Harness;
let off: Harness;

beforeAll(async () => {
  on = await createHarness({ FEATURE_GUEST_TRIAL_ENABLED: 'true', GUEST_TRIAL_DAILY_LIMIT: '4' });
  off = await createHarness();
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await on?.close();
  await off?.close();
  await teardown();
});

const consent = { ageConfirmed: true, termsAccepted: true };
const start = (h: Harness, body: Record<string, unknown>, ip = '203.0.113.7') =>
  h.app.inject({ method: 'POST', url: '/v1/trial/start', remoteAddress: ip, payload: { deviceId: randomUUID(), ...consent, ...body } as never });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe('opening a trial', () => {
  it('is closed while the switch is off', async () => {
    const res = await start(off, {});
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('SERVICE_DISABLED');
  });

  it('asks for 18+ and the terms, as an account does', async () => {
    expect((await start(on, { ageConfirmed: false })).statusCode).toBe(400);
    expect((await start(on, { termsAccepted: false })).statusCode).toBe(400);
  });

  it('makes a guest with one song to spend, affirmed and recorded as such', async () => {
    const res = await start(on, {});
    expect(res.statusCode).toBe(201);
    const { token, userId } = res.json() as { token: string; userId: string };
    const me = await on.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(token) });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ role: 'guest', ageConfirmed: true });
    expect((await getBalance(userId)).available).toBe(1);
    // What the trial keeps about the visitor: two keyed hashes, never the address.
    const row = await queryOne<{ device_ref: string; ip_ref: string }>('SELECT device_ref, ip_ref FROM guest_trials WHERE user_id = ?', [userId]);
    expect(row!.ip_ref).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.ip_ref).not.toContain('203.0.113.7');
    expect(row!.device_ref).toMatch(/^[0-9a-f]{64}$/);
  });

  it('records which wording the visitor confirmed', async () => {
    const { CONSENT_VERSION } = await import('@yuha/contracts');
    const g = (await start(on, {})).json() as { userId: string };
    const row = await queryOne<{ consent_version: string | null }>('SELECT consent_version FROM users WHERE id = ?', [g.userId]);
    expect(row!.consent_version).toBe(CONSENT_VERSION);
  });

  it('opens once per device', async () => {
    const deviceId = randomUUID();
    expect((await start(on, { deviceId })).statusCode).toBe(201);
    const again = await start(on, { deviceId }, '198.51.100.9');
    expect(again.statusCode).toBe(429);
    expect(again.json().error).toMatchObject({ code: 'TRIAL_LIMIT_REACHED', details: { reason: 'device' } });
  });

  it('opens three times a day per network', async () => {
    for (let i = 0; i < 3; i += 1) expect((await start(on, {}, '192.0.2.50')).statusCode).toBe(201);
    const fourth = await start(on, {}, '192.0.2.50');
    expect(fourth.statusCode).toBe(429);
    expect(fourth.json().error.details.reason).toBe('network');
  });

  it('stops at the day’s total, whoever asks', async () => {
    for (let i = 0; i < 4; i += 1) expect((await start(on, {}, `192.0.2.${10 + i}`)).statusCode).toBe(201);
    const over = await start(on, {}, '192.0.2.99');
    expect(over.statusCode).toBe(429);
    expect(over.json().error.details.reason).toBe('day');
  });
});

describe('what a guest may do', () => {
  async function guest() {
    const res = await start(on, {}, `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`);
    return (res.json() as { token: string; userId: string });
  }

  it('makes one song, a minute long, at the back of the queue', async () => {
    const g = await guest();
    const res = await on.app.inject({
      method: 'POST',
      url: '/v1/generations',
      headers: { ...bearer(g.token), 'idempotency-key': `guest-${randomUUID()}` },
      payload: { mode: 'simple', prompt: '海边的傍晚', instrumental: false, durationSeconds: 120 } as never,
    });
    expect(res.statusCode).toBe(202);
    const job = await queryOne<{ priority: number; duration: unknown }>(
      `SELECT priority, JSON_EXTRACT(input, '$.durationSeconds') AS duration FROM generation_jobs WHERE id = ?`,
      [res.json().jobId],
    );
    expect(Number(job!.duration)).toBe(60);
    expect(job!.priority).toBe(1);
    // One song: the second has nothing to spend.
    const second = await on.app.inject({
      method: 'POST',
      url: '/v1/generations',
      headers: { ...bearer(g.token), 'idempotency-key': `guest-${randomUUID()}` },
      payload: { mode: 'simple', prompt: '又一首', instrumental: false, durationSeconds: 60 } as never,
    });
    expect(second.json().error.code).toBe('INSUFFICIENT_CREDITS');
  });

  it('is refused everything that buys, downloads or lists', async () => {
    const g = await guest();
    for (const [method, url] of [
      ['GET', '/v1/tracks'],
      ['GET', '/v1/entitlements'],
      ['POST', '/v1/checkout'],
      ['POST', '/v1/me/source'],
    ] as const) {
      const res = await on.app.inject({ method, url, headers: bearer(g.token), payload: {} as never });
      expect({ url, status: res.statusCode }).toEqual({ url, status: 403 });
    }
  });

  it('waits when three trial songs are already queued', async () => {
    const post = async () => {
      const g = await guest();
      return on.app.inject({
        method: 'POST',
        url: '/v1/generations',
        headers: { ...bearer(g.token), 'idempotency-key': `guest-${randomUUID()}` },
        payload: { mode: 'simple', prompt: '雨', instrumental: true, durationSeconds: 60 } as never,
      });
    };
    for (let i = 0; i < 3; i += 1) expect((await post()).statusCode).toBe(202);
    const fourth = await post();
    expect(fourth.statusCode).toBe(503);
    expect(fourth.json().error.code).toBe('TRIAL_BUSY');
  });
});

describe('the queue', () => {
  it('admits an account’s song before a trial’s that came first, and positions say so', async () => {
    const { startMusicDispatch, withTxRetry, queuePositions, getJob } = await import('@yuha/db');
    const g = (await start(on, {}, '10.20.30.40')).json() as { token: string };
    const make = (headers: Record<string, string>) =>
      on.app.inject({
        method: 'POST',
        url: '/v1/generations',
        headers: { ...headers, 'idempotency-key': `q-${randomUUID()}` },
        payload: { mode: 'simple', prompt: '雨の駅', instrumental: true, durationSeconds: 60 } as never,
      });
    const guestJob = (await make(bearer(g.token))).json().jobId as string;
    const user = await on.createUser({ credits: 2 });
    const accountJob = (await make(user.authHeader)).json().jobId as string;
    const providerId = on.ctx.music.capabilities().providerId;
    const dispatch = (jobId: string) =>
      withTxRetry((tx) => startMusicDispatch({ jobId, owner: 'test', providerId, limit: 1, leaseSeconds: 60, queueDeadlineSeconds: 3600 }, tx));

    const positions = await queuePositions([(await getJob(guestJob))!, (await getJob(accountJob))!]);
    expect(positions.get(accountJob)).toBe(1);
    expect(positions.get(guestJob)).toBe(2);
    // With room for one, the trial's song waits although it was first.
    expect(await dispatch(guestJob)).toBeUndefined();
    expect((await dispatch(accountJob))?.id).toBe(accountJob);
  });
});

describe('keeping the song, or losing it after seven days', () => {
  async function guestSong() {
    const { claimOutboxBatch, withTx } = await import('@yuha/db');
    const { runJobStep } = await import('@yuha/worker/pipeline');
    const g = (await start(on, {}, `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`)).json() as { token: string; userId: string };
    const res = await on.app.inject({
      method: 'POST',
      url: '/v1/generations',
      headers: { ...bearer(g.token), 'idempotency-key': `keep-${randomUUID()}` },
      payload: { mode: 'simple', prompt: '夏の終わり', instrumental: false, durationSeconds: 60 } as never,
    });
    expect(res.statusCode).toBe(202);
    const jobId = res.json().jobId as string;
    const rows = await withTx((tx) => claimOutboxBatch(50, tx));
    for (const row of rows) await on.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
    for (let i = 0; i < 6; i += 1) {
      await runJobStep({ ctx: on.ctx, owner: `k-${i}`, log: () => undefined }, jobId);
      const t = await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]);
      if (t) return { ...g, trackId: t.id, jobId };
    }
    throw new Error('not delivered');
  }
  const snapshotOwner = async (trackId: string) =>
    (await queryOne<{ user_id: string }>('SELECT user_id FROM license_snapshots WHERE track_id = ?', [trackId]))?.user_id ?? null;
  const consentOf = (user: { authHeader: Record<string, string> }) =>
    on.app.inject({ method: 'POST', url: '/v1/me/consent', headers: user.authHeader, payload: { ageConfirmed: true, termsAccepted: true } as never });
  const claim = (user: { authHeader: Record<string, string> }, guestToken: string) =>
    on.app.inject({ method: 'POST', url: '/v1/trial/claim', headers: user.authHeader, payload: { guestToken } as never });

  it('tells a guest which song is its trial, even if this browser never saw it finish', async () => {
    const fresh = (await start(on, {}, '10.88.1.1')).json() as { token: string };
    const none = await on.app.inject({ method: 'GET', url: '/v1/trial/song', headers: bearer(fresh.token) });
    expect(none.statusCode).toBe(200);
    expect(none.json()).toEqual({ trackId: null });

    const g = await guestSong();
    const res = await on.app.inject({ method: 'GET', url: '/v1/trial/song', headers: bearer(g.token) });
    expect(res.json()).toEqual({ trackId: g.trackId });
    // Still not a library: the list stays closed to guests.
    expect((await on.app.inject({ method: 'GET', url: '/v1/tracks', headers: bearer(g.token) })).statusCode).toBe(403);
  });

  it('answers only for guests', async () => {
    const user = await on.createUser();
    const res = await on.app.inject({ method: 'GET', url: '/v1/trial/song', headers: user.authHeader });
    expect(res.statusCode).toBe(403);
  });

  it('writes no authorship record while the song is a guest’s, and the account’s when it is claimed', async () => {
    const g = await guestSong();
    expect(await snapshotOwner(g.trackId)).toBeNull();

    const user = await on.createUser();
    await consentOf(user);
    expect((await getBalance(user.id)).available).toBe(2);
    const res = await claim(user, g.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().claimed).toBe(1);

    expect((await queryOne<{ owner_id: string }>('SELECT owner_id FROM tracks WHERE id = ?', [g.trackId]))!.owner_id).toBe(user.id);
    expect(await snapshotOwner(g.trackId)).toBe(user.id);
    // Two songs free in all: the trial's, and one more.
    expect((await getBalance(user.id)).available).toBe(1);
    // The guest session has ended; the song is the account's now.
    expect((await on.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(g.token) })).statusCode).toBe(401);
    expect((await on.app.inject({ method: 'GET', url: `/v1/tracks/${g.trackId}/license`, headers: user.authHeader })).statusCode).toBe(200);
  }, 60_000);

  it('is taken only by an account that has confirmed its own age and terms', async () => {
    const { execute } = await import('@yuha/db');
    const g = await guestSong();
    const user = await on.createUser();
    // As an account is before it answers the consent gate.
    await execute('UPDATE users SET age_confirmed_at = NULL, terms_accepted_at = NULL WHERE id = ?', [user.id]);
    const before = await claim(user, g.token);
    expect(before.statusCode).toBe(403);
    expect(before.json().error.code).toBe('AGE_NOT_CONFIRMED');
    expect((await queryOne<{ owner_id: string }>('SELECT owner_id FROM tracks WHERE id = ?', [g.trackId]))!.owner_id).toBe(g.userId);
    await consentOf(user);
    expect((await claim(user, g.token)).statusCode).toBe(200);
    // Still two songs free in all.
    expect((await getBalance(user.id)).available).toBe(1);
  }, 60_000);

  it('belongs to one account only', async () => {
    const g = await guestSong();
    const first = await on.createUser();
    const second = await on.createUser();
    await consentOf(first);
    await consentOf(second);
    expect((await claim(first, g.token)).statusCode).toBe(200);
    expect((await claim(first, g.token)).json().claimed).toBe(0);
    expect((await claim(second, g.token)).statusCode).toBe(409);
  }, 60_000);

  it('is deleted with its audio, what was written and both hashes, after seven days unclaimed', async () => {
    const { purgeExpiredGuestTrials } = await import('@yuha/api');
    const { execute } = await import('@yuha/db');
    const g = await guestSong();
    const key = (await queryOne<{ storage_key: string }>('SELECT storage_key FROM asset_versions WHERE track_id = ?', [g.trackId]))!.storage_key;
    await on.ctx.storage.get('delivery', key); // there before

    // Six days on, nothing happens.
    expect(await purgeExpiredGuestTrials(on.ctx, { now: new Date(Date.now() + 6 * 86_400_000) })).toBe(0);
    await execute('UPDATE guest_trials SET created_at = UTC_TIMESTAMP(3) - INTERVAL 8 DAY WHERE user_id = ?', [g.userId]);
    expect(await purgeExpiredGuestTrials(on.ctx)).toBe(1);

    await expect(on.ctx.storage.get('delivery', key)).rejects.toThrow();
    expect(await queryOne('SELECT id FROM asset_versions WHERE track_id = ?', [g.trackId])).toBeUndefined();
    const track = await queryOne<{ state: string; lyrics: string | null }>('SELECT state, lyrics FROM tracks WHERE id = ?', [g.trackId]);
    expect(track).toMatchObject({ state: 'deleted', lyrics: null });
    const job = await queryOne<{ input: unknown }>('SELECT input FROM generation_jobs WHERE id = ?', [g.jobId]);
    expect(JSON.stringify(job!.input)).not.toContain('夏の終わり');
    const trial = await queryOne<{ device_ref: string | null; ip_ref: string | null; purged_at: Date | null }>(
      'SELECT device_ref, ip_ref, purged_at FROM guest_trials WHERE user_id = ?',
      [g.userId],
    );
    expect(trial).toMatchObject({ device_ref: null, ip_ref: null });
    expect(trial!.purged_at).not.toBeNull();
    expect((await on.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(g.token) })).statusCode).toBe(401);
  }, 60_000);

  it('keeps a claimed song, but drops its two hashes after seven days too', async () => {
    const { purgeExpiredGuestTrials } = await import('@yuha/api');
    const { execute } = await import('@yuha/db');
    const g = await guestSong();
    const user = await on.createUser();
    await consentOf(user);
    expect((await claim(user, g.token)).statusCode).toBe(200);
    const refs = () => queryOne<{ device_ref: string | null; ip_ref: string | null }>('SELECT device_ref, ip_ref FROM guest_trials WHERE user_id = ?', [g.userId]);

    await purgeExpiredGuestTrials(on.ctx);
    expect((await refs())!.device_ref).not.toBeNull(); // within the seven days: still counting trials
    await execute('UPDATE guest_trials SET created_at = UTC_TIMESTAMP(3) - INTERVAL 8 DAY WHERE user_id = ?', [g.userId]);
    expect(await purgeExpiredGuestTrials(on.ctx)).toBe(0); // nothing deleted: the song is the account's
    expect(await refs()).toMatchObject({ device_ref: null, ip_ref: null });
    expect((await queryOne<{ owner_id: string; state: string }>('SELECT owner_id, state FROM tracks WHERE id = ?', [g.trackId]))).toMatchObject({ owner_id: user.id });
    expect((await queryOne<{ state: string }>('SELECT state FROM tracks WHERE id = ?', [g.trackId]))!.state).not.toBe('deleted');
  }, 60_000);
});

describe('the key the trial limits are hashed with (docs/legal/PRIVACY_CHANGES_2026-11.md)', () => {
  it('has no public fallback: with no server secret there is no trial, not a hash anyone can reverse', async () => {
    const cfg = on.ctx.config as Record<string, unknown>;
    const saved = { s: cfg.STORAGE_SIGNING_SECRET, g: cfg.GOOGLE_SESSION_SECRET, d: cfg.DEV_AUTH_SECRET };
    cfg.STORAGE_SIGNING_SECRET = undefined;
    cfg.GOOGLE_SESSION_SECRET = undefined;
    cfg.DEV_AUTH_SECRET = undefined;
    try {
      const res = await start(on, {});
      expect(res.json().error?.code).toBe('SERVICE_DISABLED');
    } finally {
      cfg.STORAGE_SIGNING_SECRET = saved.s;
      cfg.GOOGLE_SESSION_SECRET = saved.g;
      cfg.DEV_AUTH_SECRET = saved.d;
    }
    expect(await queryOne('SELECT user_id FROM guest_trials')).toBeUndefined();
  });
});

describe('"today" for the daily limits', () => {
  it('is the day in Japan, turning at 15:00 UTC', async () => {
    const { japanDayStart } = await import('../apps/api/src/services/guest-trial.js');
    expect(japanDayStart(new Date('2026-11-23T14:59:59Z')).toISOString()).toBe('2026-11-22T15:00:00.000Z');
    expect(japanDayStart(new Date('2026-11-23T15:00:00Z')).toISOString()).toBe('2026-11-23T15:00:00.000Z');
    expect(japanDayStart(new Date('2026-11-23T00:30:00Z')).toISOString()).toBe('2026-11-22T15:00:00.000Z');
  });
});
