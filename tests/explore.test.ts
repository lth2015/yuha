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

/*
 * The showcase is the one route that answers without a token, so what it does
 * NOT list matters as much as what it does. A ranked feed was removed from
 * this product once; this is the narrow replacement, and these tests are what
 * keep it narrow.
 */
describe('GET /v1/explore: the showcase', () => {
  it('lists published songs to a reader with no account at all', async () => {
    const owner = await h.createUser({ credits: 5 });
    const trackId = await deliverSong(owner, 'showcase-pub', 'public');

    const res = await h.app.inject({ method: 'GET', url: '/v1/explore' });

    expect(res.statusCode).toBe(200);
    const ids = res.json().items.map((t: { trackId: string }) => t.trackId);
    expect(ids).toContain(trackId);
  });

  it('never lists a private song (SEC-01)', async () => {
    const owner = await h.createUser({ credits: 5 });
    const publicId = await deliverSong(owner, 'showcase-mix-pub', 'public');
    const privateId = await deliverSong(owner, 'showcase-mix-priv', 'private');

    const ids = (await h.app.inject({ method: 'GET', url: '/v1/explore' }))
      .json()
      .items.map((t: { trackId: string }) => t.trackId);

    expect(ids).toContain(publicId);
    expect(ids).not.toContain(privateId);
  });

  it('drops a song the moment its owner unpublishes it', async () => {
    const owner = await h.createUser({ credits: 5 });
    const trackId = await deliverSong(owner, 'showcase-revoke', 'public');

    await h.app.inject({
      method: 'POST',
      url: `/v1/tracks/${trackId}/visibility`,
      headers: owner.authHeader,
      payload: { visibility: 'private' } as never,
    });

    const ids = (await h.app.inject({ method: 'GET', url: '/v1/explore' }))
      .json()
      .items.map((t: { trackId: string }) => t.trackId);
    expect(ids).not.toContain(trackId);
  });

  it('hands out a playable preview url, so the landing page can be heard', async () => {
    const owner = await h.createUser({ credits: 5 });
    await deliverSong(owner, 'showcase-preview', 'public');

    const item = (await h.app.inject({ method: 'GET', url: '/v1/explore' })).json().items[0];
    expect(item.previewUrl).toEqual(expect.any(String));
    expect(item.previewUrl.length).toBeGreaterThan(0);
  });

  /*
   * `licensedByMe` answers "has this reader bought a licence". On this route
   * there is no reader, so the honest value is null — "not known" — and not
   * false, which would be an answer about somebody who does not exist.
   */
  it('answers null, not false, for the viewer-specific fields', async () => {
    const owner = await h.createUser({ credits: 5 });
    await deliverSong(owner, 'showcase-null', 'public');

    const item = (await h.app.inject({ method: 'GET', url: '/v1/explore' })).json().items[0];
    expect(item.licensedByMe).toBeNull();
  });

  /*
   * The feed that was deleted ranked by a like counter, and `playCount` is
   * deliberately absent from every track view: a number that cannot reach the
   * browser cannot be rendered back onto a page by a later change. This route
   * must not be the one that reintroduces it.
   */
  it('exposes no engagement counter', async () => {
    const owner = await h.createUser({ credits: 5 });
    await deliverSong(owner, 'showcase-nocount', 'public');

    const item = (await h.app.inject({ method: 'GET', url: '/v1/explore' })).json().items[0];
    expect(item).not.toHaveProperty('playCount');
    expect(item).not.toHaveProperty('likeCount');
  });
});

describe('song visibility', () => {
  it('a private song is invisible on /v1/tracks/:id even with the exact id (SEC-01)', async () => {
    const owner = await h.createUser({ credits: 5 });
    const stranger = await h.createUser();
    const trackId = await deliverSong(owner, 'vis-priv', 'private');

    const asStranger = await h.app.inject({ method: 'GET', url: `/v1/tracks/${trackId}`, headers: stranger.authHeader });
    expect(asStranger.statusCode).toBe(404);

    // Anonymous reads are allowed on this route now (a shared link must open),
    // so a private song answers 404 here too — never 401, which would confirm
    // that something exists behind the id.
    const anonymous = await h.app.inject({ method: 'GET', url: `/v1/tracks/${trackId}` });
    expect(anonymous.statusCode).toBe(404);
  });

  it('a published song opens for a reader with no account, and only what anyone may see', async () => {
    const owner = await h.createUser({ credits: 5 });
    const trackId = await deliverSong(owner, 'vis-anon', 'public');

    const res = await h.app.inject({ method: 'GET', url: `/v1/tracks/${trackId}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.trackId).toBe(trackId);
    expect(body.visibility).toBe('public');
    expect(typeof body.previewUrl).toBe('string');
    expect(body.exports).toEqual([]);
    expect(body.licensedByMe).toBeNull();
    expect(body).not.toHaveProperty('playCount');

    // A stale or forged token is read as no token, not as an error: the link
    // still opens, and the reader is still nobody in particular.
    const stale = await h.app.inject({
      method: 'GET',
      url: `/v1/tracks/${trackId}`,
      headers: { authorization: 'Bearer not-a-real-token' },
    });
    expect(stale.statusCode).toBe(200);
    expect(stale.json().exports).toEqual([]);

    // Unpublishing closes it to anonymous readers as well.
    await h.app.inject({
      method: 'POST',
      url: `/v1/tracks/${trackId}/visibility`,
      headers: owner.authHeader,
      payload: { visibility: 'private' } as never,
    });
    const after = await h.app.inject({ method: 'GET', url: `/v1/tracks/${trackId}` });
    expect(after.statusCode).toBe(404);

    // The owner still sees their own song, exports and all.
    const asOwner = await h.app.inject({ method: 'GET', url: `/v1/tracks/${trackId}`, headers: owner.authHeader });
    expect(asOwner.statusCode).toBe(200);
    expect(asOwner.json()).toHaveProperty('exports');
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
