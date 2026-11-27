/**
 * Music Gift Invitation (docs/GIFT_INVITATION_PLAN.md, PRD V1.1).
 *
 * An invitation is a link of its own for one song: unguessable, stored only
 * as a hash, revocable on its own, and opened without an account. The song
 * need not be public. What the link answers is a whitelist — words the owner
 * wrote for the recipient, and the song — never an id, a person or a storage
 * path; and its audio is a short-lived signed address issued only while the
 * invitation stands.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { timingsMatchLyrics } from '@yuha/contracts';
import { createHash, randomUUID } from 'node:crypto';
import { claimOutboxBatch, query, queryOne, withTx } from '@yuha/db';
import { runJobStep } from '@yuha/worker/pipeline';
import { redactUrlSecrets } from '../apps/api/src/log-redaction.js';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

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

const PERSON = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const invitation = { recipientName: '亲爱的你', senderName: '小林', message: '有些话说不出口，就写成一首歌送给你。', theme: 'warm' };

async function song(user: TestUser): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `gi-${randomUUID()}` },
    payload: { mode: 'custom', prompt: '秋天的傍晚', styles: ['ballad'], instrumental: false, durationSeconds: 30, lyrics: '[主歌]\n秋天的傍晚\n风吹过街角\n[副歌]\n我在等你' } as never,
  });
  const jobId = res.json().jobId as string;
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 6; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `gi-${i}`, log: () => undefined }, jobId);
    const t = await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]);
    if (t) return t.id;
  }
  throw new Error('not delivered');
}
const create = (user: TestUser, trackId: string, body: Record<string, unknown> = invitation) =>
  h.app.inject({ method: 'POST', url: `/v1/tracks/${trackId}/gifts`, headers: user.authHeader, payload: body as never });
const tokenOf = (url: string) => url.split('/gift/')[1]!;
const open = (token: string, headers: Record<string, string> = { 'user-agent': PERSON }) =>
  h.app.inject({ method: 'GET', url: `/v1/gift/${token}`, headers });
const audio = (token: string) => h.app.inject({ method: 'GET', url: `/v1/gift/${token}/audio`, headers: { 'user-agent': PERSON } });

describe('making an invitation', () => {
  it('gives the owner an unguessable link once, keeps only its hash, and works for a private song', async () => {
    const owner = await h.createUser({ credits: 2 });
    const trackId = await song(owner);
    expect((await queryOne<{ visibility: string }>(`SELECT visibility FROM tracks WHERE id = ?`, [trackId]))!.visibility).toBe('private');
    const res = await create(owner, trackId);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.url).toMatch(/\/gift\/[A-Za-z0-9_-]{43}$/);
    const token = tokenOf(body.url);
    expect(token).not.toContain(trackId);
    const row = (await queryOne<{ token_hash: string }>(`SELECT token_hash FROM gift_invitations WHERE id = ?`, [body.id]))!;
    expect(row.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(JSON.stringify(await query(`SELECT * FROM gift_invitations`))).not.toContain(token);
    // Listed afterwards without the link: it was shown once.
    const list = (await h.app.inject({ method: 'GET', url: `/v1/tracks/${trackId}/gifts`, headers: owner.authHeader })).json();
    expect(list.items).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(token);
    // Two invitations, two links.
    const second = (await create(owner, trackId, { ...invitation, theme: 'celebration' })).json();
    expect(tokenOf(second.url)).not.toBe(token);
  }, 60_000);

  it('is refused for a song that is not the caller’s, and for words that are too long or screened out', async () => {
    const owner = await h.createUser({ credits: 2 });
    const other = await h.createUser({ credits: 0 });
    const trackId = await song(owner);
    expect((await create(other, trackId)).statusCode).toBe(404);
    expect((await create(owner, trackId, { ...invitation, message: '字'.repeat(301) })).statusCode).toBe(400);
    expect((await create(owner, trackId, { ...invitation, theme: 'gothic' })).statusCode).toBe(400);
    // Screened like a dedication: refused before anything is stored.
    expect((await create(owner, trackId, { ...invitation, message: 'listen at https://evil.example/' })).statusCode).toBe(422);
    expect((await create(owner, trackId, { ...invitation, recipientName: '' })).statusCode).toBe(400);
    expect(await query(`SELECT id FROM gift_invitations`)).toHaveLength(0);
  }, 60_000);
});

describe('opening an invitation', () => {
  it('needs no account, and answers only the words and the song', async () => {
    const owner = await h.createUser({ credits: 2 });
    const trackId = await song(owner);
    const token = tokenOf((await create(owner, trackId)).json().url);
    const res = await open(token);
    expect(res.statusCode).toBe(200);
    const g = res.json();
    expect(g).toMatchObject({ recipientName: '亲爱的你', senderName: '小林', message: invitation.message, theme: 'warm' });
    expect(g.song.title).toBeTruthy();
    expect(g.song.durationSeconds).toBeGreaterThan(0);
    const raw = JSON.stringify(g);
    for (const secret of [trackId, owner.id, 'storage', 'key', 'master', 'owner', 'email']) expect(raw).not.toContain(secret);
    expect(res.headers['x-robots-tag']).toMatch(/noindex/);
    expect(res.headers['cache-control']).toMatch(/no-store/);

    // The words, and the timeline to follow them by (recipients could not see
    // the lyrics at all, 2026-11-27): the song page's own, one line per line.
    expect(g.song.lyrics).toBeTruthy();
    expect(g.song.lyricTimings?.lines.length).toBeGreaterThan(0);
    expect(timingsMatchLyrics(g.song.lyrics, g.song.lyricTimings)).toBe(true);
    expect(g.song.lyricTimings).not.toHaveProperty('fallbackReason');

    const a = await audio(token);
    expect(a.statusCode).toBe(200);
    expect(a.json().url).toBeTruthy();
    expect(new Date(a.json().expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);
  }, 60_000);

  it('answers the same not-found for a wrong, a revoked and a deleted-song link', async () => {
    const owner = await h.createUser({ credits: 3 });
    const a = await song(owner);
    const b = await song(owner);
    const ta = tokenOf((await create(owner, a)).json().url);
    const made = (await create(owner, a, { ...invitation, theme: 'romantic' })).json();
    const tb = tokenOf((await create(owner, b)).json().url);

    const revoke = await h.app.inject({ method: 'POST', url: `/v1/gifts/${made.id}/revoke`, headers: owner.authHeader });
    expect(revoke.statusCode).toBe(200);
    const revokedToken = tokenOf(made.url);
    expect((await open(revokedToken)).statusCode).toBe(404);
    expect((await audio(revokedToken)).statusCode).toBe(404);
    // Revoking one leaves its sibling.
    expect((await open(ta)).statusCode).toBe(200);

    await h.app.inject({ method: 'DELETE', url: `/v1/tracks/${b}`, headers: owner.authHeader });
    expect((await open(tb)).statusCode).toBe(404);
    expect((await audio(tb)).statusCode).toBe(404);
    expect((await queryOne<{ message: string | null; status: string }>(`SELECT message, status FROM gift_invitations WHERE track_id = ?`, [b]))).toMatchObject({ message: null, status: 'revoked' });

    expect((await open('A'.repeat(43))).statusCode).toBe(404);
    expect((await open('short')).statusCode).toBe(404);
    const bodies = await Promise.all([revokedToken, tb, 'A'.repeat(43)].map(async (t) => (await open(t)).json()));
    expect(new Set(bodies.map((x) => JSON.stringify(x.error.code))).size).toBe(1);
  }, 90_000);

  it('only its owner can change or revoke it, and a revoked one cannot be changed', async () => {
    const owner = await h.createUser({ credits: 2 });
    const other = await h.createUser({ credits: 0 });
    const made = (await create(owner, await song(owner))).json();
    const patch = (u: TestUser, body: Record<string, unknown>) =>
      h.app.inject({ method: 'PATCH', url: `/v1/gifts/${made.id}`, headers: u.authHeader, payload: body as never });
    expect((await patch(other, { message: 'mine now' })).statusCode).toBe(404);
    expect((await h.app.inject({ method: 'POST', url: `/v1/gifts/${made.id}/revoke`, headers: other.authHeader })).statusCode).toBe(404);
    expect((await patch(owner, { message: '换一句话' })).statusCode).toBe(200);
    expect((await open(tokenOf(made.url))).json().message).toBe('换一句话');
    await h.app.inject({ method: 'POST', url: `/v1/gifts/${made.id}/revoke`, headers: owner.authHeader });
    expect((await patch(owner, { message: 'again' })).statusCode).toBe(409);
  }, 60_000);
});

describe('counting what happens to an invitation', () => {
  it('records a view, a play and the call to make one, once per visitor a day, and not for crawlers', async () => {
    const owner = await h.createUser({ credits: 2 });
    const token = tokenOf((await create(owner, await song(owner))).json().url);
    const event = (name: string, visitor: string, ua = PERSON) =>
      h.app.inject({ method: 'POST', url: `/v1/gift/${token}/events`, headers: { 'user-agent': ua }, payload: { name, visitor } as never });
    const v = randomUUID();
    for (const name of ['view', 'view', 'play_start', 'play_complete', 'cta_click']) expect((await event(name, v)).statusCode).toBe(202);
    expect((await event('view', randomUUID(), 'facebookexternalhit/1.1')).statusCode).toBe(202);
    expect((await event('hack', v)).statusCode).toBe(400);
    const rows = await query<{ name: string; props: unknown }>(`SELECT name, props FROM analytics_events WHERE name LIKE 'gift\\_%' ORDER BY occurred_at`);
    expect(rows.map((r) => r.name).sort()).toEqual(['gift_created', 'gift_cta_click', 'gift_play_complete', 'gift_play_start', 'gift_view'].sort());
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(JSON.stringify(rows)).not.toContain(invitation.message);
  }, 60_000);
});

describe('the request log', () => {
  it('never holds a whole invitation token', () => {
    const token = 'abcDEF0123456789abcDEF0123456789abcDEF01234';
    for (const url of [`/v1/gift/${token}`, `/v1/gift/${token}/audio`, `/gift/${token}?x=1`]) {
      const out = redactUrlSecrets(url);
      expect(out).not.toContain(token);
      expect(out).toMatch(/gift\//);
    }
  });
});
