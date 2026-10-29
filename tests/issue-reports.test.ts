/**
 * Reporting a problem with one song, privately (docs/ISSUE_REPORTS_SPEC.md).
 *
 * What is pinned: the owner files and follows their own reports; nobody else
 * can file, read, or learn the song exists; the report carries what the
 * server knew so nobody has to reconstruct it; staff hear the song only when
 * the owner allowed it, and every listen and every resolution is audited.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { claimOutboxBatch, query, queryOne, withTx } from '@yuha/db';
import { runJobStep } from '@yuha/worker/pipeline';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let callNo = 0;
const freshIp = () => ({ 'x-forwarded-for': `198.51.100.${(callNo++ % 200) + 10}` });

beforeAll(async () => {
  h = await createHarness({ ADMIN_MFA_REQUIRED: 'false' });
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

async function song(user: TestUser): Promise<{ trackId: string; jobId: string }> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `ir-${randomUUID()}` },
    payload: { mode: 'simple', prompt: '秋天的傍晚', instrumental: false, durationSeconds: 30 } as never,
  });
  expect(res.statusCode).toBe(202);
  const jobId = res.json().jobId as string;
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 6; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `ir-${i}`, log: () => undefined }, jobId);
    const t = await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]);
    if (t) return { trackId: t.id, jobId };
  }
  throw new Error('not delivered');
}

const file = (user: TestUser, trackId: string, body: Record<string, unknown>) =>
  h.app.inject({
    method: 'POST',
    url: `/v1/tracks/${trackId}/issues`,
    headers: { ...user.authHeader, ...freshIp(), 'user-agent': 'TestBrowser/1.0' },
    payload: body as never,
  });

const mine = (user: TestUser, trackId: string) =>
  h.app.inject({ method: 'GET', url: `/v1/tracks/${trackId}/issues`, headers: user.authHeader });

describe('the owner', () => {
  it('files a report with what the server knew attached, and sees it', async () => {
    const owner = await h.createUser({ credits: 2 });
    const { trackId, jobId } = await song(owner);
    const res = await file(owner, trackId, {
      kind: 'lyrics_out_of_sync',
      atSeconds: 37,
      note: '第二段副歌开始字幕慢了一句',
      requestId: 'req-abc123',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().reportNumber).toMatch(/^IR-[A-Z2-9]{8}$/);

    const row = await queryOne<{ context: unknown; audio_consent: number; at_seconds: number }>(
      `SELECT context, audio_consent, at_seconds FROM issue_reports WHERE track_id = ?`,
      [trackId],
    );
    const context = (typeof row!.context === 'string' ? JSON.parse(row!.context) : row!.context) as Record<string, unknown>;
    expect(context).toMatchObject({ jobId, requestId: 'req-abc123', userAgent: 'TestBrowser/1.0' });
    expect(context['lyricTimingSource']).toBeDefined();
    expect(row!.audio_consent).toBeFalsy(); // not given unless asked for
    expect(row!.at_seconds).toBe(37);

    const list = await mine(owner, trackId);
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toEqual([
      expect.objectContaining({ kind: 'lyrics_out_of_sync', atSeconds: 37, status: 'open', audioConsent: false }),
    ]);
  });

  it('is limited to ten an hour', async () => {
    const owner = await h.createUser({ credits: 2 });
    const { trackId } = await song(owner);
    for (let i = 0; i < 10; i += 1) expect((await file(owner, trackId, { kind: 'other' })).statusCode).toBe(201);
    expect((await file(owner, trackId, { kind: 'other' })).statusCode).toBe(429);
  });

  it('refuses a kind it does not know and a note that is too long', async () => {
    const owner = await h.createUser({ credits: 2 });
    const { trackId } = await song(owner);
    expect((await file(owner, trackId, { kind: 'bad_vibes' })).statusCode).toBe(400);
    expect((await file(owner, trackId, { kind: 'other', note: '长'.repeat(501) })).statusCode).toBe(400);
  });
});

describe('anybody else', () => {
  it('cannot file or read, and cannot tell the song exists', async () => {
    const owner = await h.createUser({ credits: 2 });
    const stranger = await h.createUser({ credits: 0 });
    const { trackId } = await song(owner);
    await h.app.inject({ method: 'POST', url: `/v1/tracks/${trackId}/visibility`, headers: owner.authHeader, payload: { visibility: 'public' } as never });
    await file(owner, trackId, { kind: 'other', note: 'private words' });
    expect((await file(stranger, trackId, { kind: 'other' })).statusCode).toBe(404);
    expect((await mine(stranger, trackId)).statusCode).toBe(404);
    expect((await file(stranger, randomUUID(), { kind: 'other' })).statusCode).toBe(404);
  });
});

describe('staff', () => {
  async function filed(consent: boolean) {
    const owner = await h.createUser({ credits: 2 });
    const { trackId } = await song(owner);
    await file(owner, trackId, { kind: 'missing_vocals', atSeconds: 12, audioConsent: consent });
    const support = await h.createUser({ role: 'support' });
    const admin = await h.createUser({ role: 'admin' });
    const list = await h.app.inject({ method: 'GET', url: '/v1/admin/issues', headers: support.authHeader });
    expect(list.statusCode).toBe(200);
    const item = (list.json().items as Array<{ id: string }>)[0]!;
    return { owner, trackId, support, admin, item };
  }

  it('see the open reports with their context', async () => {
    const { item, trackId } = await filed(false);
    expect(item).toMatchObject({ kind: 'missing_vocals', atSeconds: 12, audioConsent: false, trackId });
    // Support sees a masked address, as everywhere in the console.
    expect((item as unknown as { userEmail: string }).userEmail).toContain('*');
  });

  it('cannot hear a song the owner did not allow', async () => {
    const { support, item } = await filed(false);
    const res = await h.app.inject({ method: 'POST', url: `/v1/admin/issues/${item.id}/audio-url`, headers: support.authHeader });
    expect(res.statusCode).toBe(403);
  });

  it('can hear one the owner allowed, and the listen is audited', async () => {
    const { support, item } = await filed(true);
    const res = await h.app.inject({ method: 'POST', url: `/v1/admin/issues/${item.id}/audio-url`, headers: support.authHeader });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toBeTruthy();
    const audit = await query<{ action: string; actor_id: string }>(`SELECT action, actor_id FROM audit_logs WHERE subject_id = ?`, [item.id]);
    expect(audit).toEqual([expect.objectContaining({ action: 'issue_report.audio_opened', actor_id: (support as { id: string }).id })]);
  });

  it('resolve it with a note the owner then sees', async () => {
    const { owner, trackId, support, item } = await filed(false);
    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/admin/issues/${item.id}/resolve`,
      headers: support.authHeader,
      payload: { reason: '已重新对齐歌词，请刷新再听' } as never,
    });
    expect(res.statusCode).toBe(200);
    const list = await mine(owner, trackId);
    expect(list.json().items[0]).toMatchObject({ status: 'resolved', resolution: '已重新对齐歌词，请刷新再听' });
    const again = await h.app.inject({
      method: 'POST',
      url: `/v1/admin/issues/${item.id}/resolve`,
      headers: support.authHeader,
      payload: { reason: '再处理一次' } as never,
    });
    expect(again.statusCode).toBe(409);
  });

  it('is staff only', async () => {
    const { owner } = await filed(true);
    expect((await h.app.inject({ method: 'GET', url: '/v1/admin/issues', headers: owner.authHeader })).statusCode).toBe(403);
  });
});
