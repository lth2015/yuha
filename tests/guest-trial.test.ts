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
      ['GET', '/v1/jobs'],
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
