import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { importOfficialBgm } from '../apps/api/src/services/official-bgm-import.js';
import { createHarness, resetData, teardown, type Harness } from './helpers/harness.js';

let off: Harness;
let staff: Harness;
let publicMarket: Harness;

beforeAll(async () => {
  off = await createHarness();
  staff = await createHarness({ OFFICIAL_BGM_MARKETPLACE: 'staff' });
  publicMarket = await createHarness({ OFFICIAL_BGM_MARKETPLACE: 'all', ADMIN_MFA_REQUIRED: 'false' });
});
beforeEach(async () => await resetData());
afterAll(async () => {
  await Promise.all([off?.close(), staff?.close(), publicMarket?.close()]);
  await teardown();
});

describe('official BGM catalogue', () => {
  it('starts closed and advertises exactly who can read the catalogue', async () => {
    const creator = await staff.createUser();
    const operator = await staff.createUser({ role: 'support' });
    for (const [h, headers, enabled] of [
      [off, operator.authHeader, false], [staff, creator.authHeader, false],
      [staff, operator.authHeader, true], [publicMarket, {}, true],
    ] as const) {
      const runtime = await h.app.inject({ url: '/v1/runtime', headers });
      expect(runtime.json().features.officialBgmMarketplace).toBe(enabled);
      const response = await h.app.inject({ url: '/v1/marketplace/bgm', headers });
      expect(response.statusCode).toBe(enabled ? 200 : 404);
      if (enabled) expect(response.json()).toEqual({ items: [], nextOffset: null });
    }
  });

  it('imports a repeatable private draft and only exposes its separately encoded preview after review', async () => {
    const admin = await publicMarket.createUser({ role: 'admin' });
    const support = await publicMarket.createUser({ role: 'support' });
    const source = execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i',
      'sine=frequency=440:sample_rate=44100', '-t', '66', '-b:a', '192k', '-f', 'mp3', 'pipe:1'], { maxBuffer: 8_000_000 });
    const input = { sourceKey: 'test-batch-01', title: 'Morning shore', genre: 'lofi', scenario: 'travel', mood: 'calm' } as const;
    await expect(importOfficialBgm(publicMarket.ctx, input, Buffer.from('not audio')))
      .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    const put = vi.spyOn(publicMarket.ctx.storage, 'put');
    const [created, concurrent] = await Promise.all([
      importOfficialBgm(publicMarket.ctx, input, source),
      importOfficialBgm(publicMarket.ctx, input, source),
    ]);
    expect(concurrent.id).toBe(created.id);
    expect([created.status, concurrent.status].sort()).toEqual(['existing', 'imported']);
    expect(put).toHaveBeenCalledTimes(2);
    put.mockRestore();
    const repeated = await importOfficialBgm(publicMarket.ctx, input, source);
    expect(repeated).toEqual({ id: created.id, status: 'existing' });
    const adminBase = '/v1/admin/marketplace/bgm';
    const preview = `/v1/marketplace/bgm/${created.id}/preview`;
    const state = (action: string) => publicMarket.app.inject({ method: 'POST', url: `${adminBase}/${created.id}/state`,
      headers: admin.authHeader, payload: { action, reason: 'Verified in the catalogue review' } });

    expect((await publicMarket.app.inject({ url: adminBase, headers: support.authHeader })).statusCode).toBe(403);
    expect((await publicMarket.app.inject({ url: adminBase, headers: admin.authHeader })).json().items).toMatchObject([
      { id: created.id, state: 'draft', title: input.title, previewStartSeconds: expect.any(Number) },
    ]);
    expect((await publicMarket.app.inject({ url: preview })).statusCode).toBe(404);
    const draft = await publicMarket.app.inject({ url: `${adminBase}/${created.id}/preview`, headers: admin.authHeader });
    expect(draft.statusCode).toBe(200);
    expect(new URL(draft.json().url).searchParams.get('key')).toMatch(/^official-bgm\/previews\//);
    expect((await state('publish')).statusCode).toBe(409);
    expect((await state('review')).json().state).toBe('reviewed');
    expect((await publicMarket.app.inject({ url: preview })).statusCode).toBe(404);
    expect((await state('publish')).json().state).toBe('published');

    const list = await publicMarket.app.inject({ url: '/v1/marketplace/bgm?genre=lofi&q=morning' });
    const item = list.json().items[0];
    expect(item).toEqual({ id: created.id, title: input.title, genre: 'lofi', scenario: 'travel', mood: 'calm',
      durationSeconds: expect.any(Number), previewSeconds: expect.any(Number) });
    expect(item.durationSeconds).toBeGreaterThan(60);
    expect((await publicMarket.app.inject({ url: '/v1/marketplace/bgm?q=%25' })).json().items).toEqual([]);

    const signed = await publicMarket.app.inject({ url: preview });
    expect(signed.headers['cache-control']).toBe('no-store');
    const mediaUrl = new URL(signed.json().url);
    const media = await publicMarket.app.inject({ url: mediaUrl.pathname + mediaUrl.search });
    expect(media.statusCode).toBe(200);
    expect(media.headers['content-type']).toBe('audio/mpeg');
    const range = await publicMarket.app.inject({ url: mediaUrl.pathname + mediaUrl.search, headers: { range: 'bytes=0-2047' } });
    expect(range.statusCode).toBe(206);
    expect(range.rawPayload).toEqual(media.rawPayload.subarray(0, 2048));
    expect(media.rawPayload.equals(source)).toBe(false);
    const metadata = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=bit_rate',
      '-of', 'json', 'pipe:0'], { input: media.rawPayload, encoding: 'utf8' }));
    expect(Number(metadata.streams[0].bit_rate)).toBe(128_000);
    const probed = await publicMarket.ctx.audio.probe(media.rawPayload);
    expect(probed?.durationMs).toBeGreaterThan(1000);
    expect(probed!.durationMs).toBeLessThanOrEqual(60_000);
    const storage = publicMarket.ctx.storage;
    const realSign = storage.signedUrl.bind(storage);
    let startSigning!: () => void;
    let releaseSigning!: () => void;
    const started = new Promise<void>((resolve) => { startSigning = resolve; });
    const release = new Promise<void>((resolve) => { releaseSigning = resolve; });
    const signing = vi.spyOn(storage, 'signedUrl').mockImplementationOnce(async (input) => {
      startSigning();
      await release;
      return realSign(input);
    });
    const inFlight = publicMarket.app.inject({ url: preview });
    await started;
    const archive = state('archive');
    try {
      const observed = await Promise.race([
        archive.then(() => 'archived'),
        new Promise<string>((resolve) => setTimeout(() => resolve('signing'), 150)),
      ]);
      expect(observed).toBe('signing');
    } finally {
      releaseSigning();
      await Promise.allSettled([inFlight, archive]);
      signing.mockRestore();
    }
    expect((await inFlight).statusCode).toBe(200);
    expect((await archive).json().state).toBe('archived');
    expect((await publicMarket.app.inject({ url: preview })).statusCode).toBe(404);
    expect((await publicMarket.app.inject({ url: '/v1/marketplace/bgm' })).json().items).toEqual([]);
    expect((await state('publish')).statusCode).toBe(409);
    expect((await state('review')).json().state).toBe('reviewed');
  }, 30_000);
});
