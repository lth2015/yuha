/**
 * Song visibility, play counters and the Google one-time-code exchange.
 *
 * The privacy rule under test throughout: a song is readable by anyone else
 * only while its owner has its link turned on; everything else stays
 * invisible no matter how precisely its id is known (SEC-01).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '@yuha/db';
import {
  createHarness,
  resetData,
  teardown,
  type Harness,
  type TestUser,
} from './helpers/harness';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

const log = () => undefined;

/** Delivers one real song through the worker pipeline and returns its track id. */
async function deliverSong(user: TestUser, key: string, visibility: 'private' | 'public'): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': key },
    payload: {
      mode: 'simple',
      prompt: `a quiet walk ${key}`,
      styles: ['chill'],
      instrumental: true,
      energy: 0.4,
      durationSeconds: 30,
      visibility,
    } as never,
  });
  expect(res.statusCode).toBe(202);
  const { jobId } = res.json();

  const { runJobStep } = await import('@yuha/worker/pipeline');
  for (let i = 0; i < 6; i += 1) {
    const job = await query<{ state: string; track_id: string | null }>(
      `SELECT state, track_id FROM generation_jobs WHERE id = ?`,
      [jobId],
    );
    if (['DELIVERED', 'FAILED', 'REJECTED'].includes(job[0]!.state)) {
      expect(job[0]!.state).toBe('DELIVERED');
      return job[0]!.track_id!;
    }
    await runJobStep({ ctx: h.ctx, owner: `test-${i}`, log }, jobId);
  }
  throw new Error('song did not reach DELIVERED');
}

describe('song visibility', () => {
  it('a private song is invisible on /v1/tracks/:id even with the exact id (SEC-01)', async () => {
    const owner = await h.createUser({ credits: 5 });
    const stranger = await h.createUser();
    const trackId = await deliverSong(owner, 'vis-priv', 'private');

    const asStranger = await h.app.inject({ method: 'GET', url: `/v1/tracks/${trackId}`, headers: stranger.authHeader });
    expect(asStranger.statusCode).toBe(404);

    const anonymous = await h.app.inject({ method: 'GET', url: `/v1/tracks/${trackId}` });
    expect(anonymous.statusCode).toBe(401);
  });

  it('the owner can publish and unpublish; a stranger loses access on unpublish', async () => {
    const owner = await h.createUser({ credits: 5 });
    const stranger = await h.createUser();
    const trackId = await deliverSong(owner, 'vis-toggle', 'private');

    const publish = await h.app.inject({
      method: 'POST',
      url: `/v1/tracks/${trackId}/visibility`,
      headers: owner.authHeader,
      payload: { visibility: 'public' } as never,
    });
    expect(publish.statusCode).toBe(200);

    // A stranger holding the link can now read it.
    const asStranger = await h.app.inject({ method: 'GET', url: `/v1/tracks/${trackId}`, headers: stranger.authHeader });
    expect(asStranger.statusCode).toBe(200);
    expect(asStranger.json().visibility).toBe('public');

    // Unpublishing revokes the link for everyone but the owner.
    await h.app.inject({
      method: 'POST',
      url: `/v1/tracks/${trackId}/visibility`,
      headers: owner.authHeader,
      payload: { visibility: 'private' } as never,
    });
    const afterRevoke = await h.app.inject({ method: 'GET', url: `/v1/tracks/${trackId}`, headers: stranger.authHeader });
    expect(afterRevoke.statusCode).toBe(404);

    const row = await query<{ visibility: string }>(
      `SELECT visibility FROM tracks WHERE id = ?`,
      [trackId],
    );
    expect(row[0]).toMatchObject({ visibility: 'private' });
  });

  it('only the owner can change visibility', async () => {
    const owner = await h.createUser({ credits: 5 });
    const stranger = await h.createUser();
    const trackId = await deliverSong(owner, 'vis-owner', 'private');

    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/tracks/${trackId}/visibility`,
      headers: stranger.authHeader,
      payload: { visibility: 'public' } as never,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('plays', () => {
  it('play counters only move for published songs', async () => {
    const owner = await h.createUser({ credits: 5 });
    const publicId = await deliverSong(owner, 'play-pub', 'public');
    const privateId = await deliverSong(owner, 'play-priv', 'private');

    await h.app.inject({ method: 'POST', url: `/v1/explore/${publicId}/plays` });
    await h.app.inject({ method: 'POST', url: `/v1/explore/${privateId}/plays` });

    const rows = await query<{ id: string; play_count: number }>(
      `SELECT id, play_count FROM tracks WHERE id IN (?, ?)`,
      [publicId, privateId],
    );
    const byId = new Map(rows.map((r) => [r.id, Number(r.play_count)]));
    expect(byId.get(publicId)).toBe(1);
    expect(byId.get(privateId)).toBe(0);
  });
});

describe('Google one-time codes', () => {
  it('a code is consumed exactly once and expires quickly', async () => {
    const { issueAuthCode, consumeAuthCode } = await import('@yuha/db');
    const user = await h.createUser();

    const { code } = await issueAuthCode({ userId: user.id });
    const first = await consumeAuthCode(code);
    expect(first?.userId).toBe(user.id);

    // Replay is a hard failure, not a second session.
    const replay = await consumeAuthCode(code);
    expect(replay).toBeNull();

    // An expired code is refused.
    const { code: expiring } = await issueAuthCode({ userId: user.id });
    await query(`UPDATE auth_codes SET expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 1 MINUTE) WHERE code_hash = SHA2(?, 256)`, [expiring]);
    expect(await consumeAuthCode(expiring)).toBeNull();
  });

  it('the exchange endpoint rejects unknown codes without creating a session', async () => {
    // A harness with google credentials present: the route registers, but the
    // code itself is unknown, so no session is minted.
    const gh = await createHarness({
      GOOGLE_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'test-secret',
      GOOGLE_REDIRECT_URI: 'http://localhost:4000/v1/auth/google/callback',
    });
    try {
      const res = await gh.app.inject({
        method: 'POST',
        url: '/v1/auth/google/exchange',
        payload: { code: 'definitely-not-a-real-code-1234' } as never,
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('AUTH_EXCHANGE_FAILED');
    } finally {
      await gh.close();
    }
  });

  it('the auth config advertises google as unconfigured without credentials', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/v1/auth/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json().google.enabled).toBe(false);
    expect(res.json().devLogin).toBe(true);
  });
});
