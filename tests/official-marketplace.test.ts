import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { officialBgmInventoryFor, officialBgmInventoryReport, officialBgmSourceKey, parseOfficialBgmManifest } from '@yuha/contracts';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importOfficialBgm } from '../apps/api/src/services/official-bgm-import.js';
import { officialBgmStyleTags } from '@yuha/contracts';
import { startingRating } from '@yuha/db';
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

  it('protects the browser import before reading uploaded media', async () => {
    const support = await publicMarket.createUser({ role: 'support' });
    const admin = await publicMarket.createUser({ role: 'admin' });
    const request = (headers: Record<string, string>) => publicMarket.app.inject({
      method: 'POST', url: '/v1/admin/marketplace/bgm/import',
      headers: { ...headers, 'content-type': 'multipart/form-data; boundary=missing' }, payload: 'not a file',
    });
    expect((await request({})).statusCode).toBe(401);
    expect((await request(support.authHeader)).statusCode).toBe(403);
    expect((await request(admin.authHeader)).statusCode).toBe(400);
  });

  it('imports a DGXA WAV with its original bytes, report and private provenance', async () => {
    const admin = await publicMarket.createUser({ role: 'admin' });
    const source = execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i',
      'sine=frequency=520:sample_rate=44100', '-t', '61', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'], { maxBuffer: 8_000_000 });
    const cover = await readFile(new URL('../apps/web/public/brand/og-card.png', import.meta.url));
    const csv = '\uFEFFid,file,title,series,style,mood,scenario,cover,model,model_version,seed,prompt,generated_at,note\r\n' +
      '01,晨光.wav,"First light, for you",Spring,Japanese healing,calm,travel,covers/01.png,ACE-Step,v1.5,9007199254740993,"Warm ""strings""\nsoft piano",2026-11-27T17:00:00+09:00,////';
    const rejected: number[] = [];
    const missingProvenance = ',bad.wav,Missing metadata,Spring,jazz,calm,travel,,ACE-Step,,1,Keys,2026-11-27T17:00:00+09:00,';
    const [entry] = parseOfficialBgmManifest(`${csv}\r\n${missingProvenance}`, 'batch-01', (issue) => rejected.push(issue.row));
    expect(rejected).toEqual([3]);
    expect(officialBgmSourceKey({ batch: 'a-b', trackId: 'c' })).not.toBe(officialBgmSourceKey({ batch: 'a', trackId: 'b-c' }));
    expect(entry).toMatchObject({ genre: 'japanese_healing', title: 'First light, for you',
      provenance: { seed: '9007199254740993', prompt: 'Warm "strings"\nsoft piano', licenseStatus: 'pending', coverFilename: '01.png' } });
    const sha256 = createHash('sha256').update(source).digest('hex');
    const report = officialBgmInventoryReport.parse({ items: [{
      id: '01', file: '晨光.wav', audio: { sha256, bytes: source.byteLength, duration_s: 61 }, missing: [], problems: [],
    }] });
    const inventory = officialBgmInventoryFor(report, entry!.provenance)!.evidence;
    const adminBase = '/v1/admin/marketplace/bgm';
    const upload = async (evidence = inventory, imageBytes = cover) => {
      const form = new FormData();
      form.append('fields', JSON.stringify({ track: { ...entry, inventory: evidence } }));
      form.append('master', new Blob([new Uint8Array(source)], { type: 'audio/wav' }), '晨光.wav');
      form.append('cover', new Blob([new Uint8Array(imageBytes)], { type: 'image/png' }), '01.png');
      const wire = new Response(form);
      return publicMarket.app.inject({
        url: `${adminBase}/import`, method: 'POST', headers: { ...admin.authHeader, 'content-type': wire.headers.get('content-type')! },
        payload: Buffer.from(await wire.arrayBuffer()),
      });
    };
    expect((await upload({ ...inventory, sha256: '0'.repeat(64) })).statusCode).toBe(400);
    const brokenCover = await upload(inventory, cover.subarray(0, 8));
    expect(brokenCover.statusCode).toBe(400);
    expect(brokenCover.json().error.message).toContain('cover could not be decoded');
    expect((await publicMarket.app.inject({ url: adminBase, headers: admin.authHeader })).json().items).toEqual([]);
    const first = await upload();
    expect(first.statusCode).toBe(201);
    const { id } = first.json();
    expect((await upload()).json()).toEqual({ status: 'existing', id });
    expect((await publicMarket.ctx.storage.get('delivery', `official-bgm/masters/${sha256}.wav`)).equals(source)).toBe(true);
    const items = (await publicMarket.app.inject({ url: adminBase, headers: admin.authHeader })).json().items;
    expect(items[0]).toMatchObject({ id, state: 'draft', masterFormat: 'wav', hasCover: true, provenance: entry!.provenance });
    expect(items[0].provenance).not.toHaveProperty('coverSha256');
    const privateCover = `${adminBase}/${id}/cover`;
    expect((await publicMarket.app.inject({ url: privateCover })).statusCode).toBe(401);
    const coverUrl = new URL((await publicMarket.app.inject({ url: privateCover, headers: admin.authHeader })).json().url);
    const image = await publicMarket.app.inject({ url: coverUrl.pathname + coverUrl.search });
    expect(image.headers['content-type']).toBe('image/png');
    expect(image.rawPayload.equals(cover)).toBe(true);
    expect((await publicMarket.app.inject({ url: '/v1/marketplace/bgm' })).json().items).toEqual([]);
    for (const action of ['review', 'publish']) {
      expect((await publicMarket.app.inject({ method: 'POST', url: `${adminBase}/${id}/state`, headers: admin.authHeader,
        payload: { action, reason: 'Audio and original rights record checked' } })).statusCode).toBe(200);
    }
    const exposed = (await publicMarket.app.inject({ url: '/v1/marketplace/bgm' })).json().items[0];
    expect(exposed).toMatchObject({ id, title: entry!.title, previewSeconds: expect.any(Number) });
    expect(exposed).not.toHaveProperty('provenance');
    expect(exposed).not.toHaveProperty('masterFormat');
    expect(exposed).not.toHaveProperty('hasCover');
    const signed = await publicMarket.app.inject({ url: `/v1/marketplace/bgm/${id}/preview` });
    const preview = new URL(signed.json().url);
    expect(preview.searchParams.get('key')).toMatch(/^official-bgm\/previews\//);
    expect(exposed.previewSeconds).toBeLessThanOrEqual(60);
  }, 30_000);

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
      durationSeconds: expect.any(Number), previewSeconds: expect.any(Number),
      copy: {}, tags: [], rating: expect.any(Number) });
    // A new track's editorial score starts in 3.8–4.5 (product owner, 2026-11-27).
    expect(item.rating).toBeGreaterThanOrEqual(3.8);
    expect(item.rating).toBeLessThanOrEqual(4.5);
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
    const probeDir = await mkdtemp(join(tmpdir(), 'official-bgm-preview-'));
    try {
      const path = join(probeDir, 'preview.mp3');
      await writeFile(path, media.rawPayload);
      const metadata = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=bit_rate',
        '-of', 'json', path], { encoding: 'utf8' }));
      expect(Number(metadata.streams[0].bit_rate)).toBe(128_000);
    } finally {
      await rm(probeDir, { recursive: true, force: true });
    }
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

  it('describes a track in three languages with tags and a score, and publishes every draft at once', async () => {
    const admin = await publicMarket.createUser({ role: 'admin' });
    const support = await publicMarket.createUser({ role: 'support' });
    const tone = (hz: number) => execFileSync('ffmpeg', ['-hide_banner', '-v', 'error', '-f', 'lavfi', '-i',
      `sine=frequency=${hz}:sample_rate=44100`, '-t', '62', '-b:a', '128k', '-f', 'mp3', 'pipe:1'], { maxBuffer: 8_000_000 });
    const a = await importOfficialBgm(publicMarket.ctx, { sourceKey: 'cat-01', title: 'Harbour', genre: 'jazz', scenario: 'travel', mood: 'warm' }, tone(330));
    const b = await importOfficialBgm(publicMarket.ctx, { sourceKey: 'cat-02', title: 'Lanterns', genre: 'ambient', scenario: 'vlog', mood: 'calm' }, tone(550));
    const base = '/v1/admin/marketplace/bgm';

    const edit = { copy: { zh: { title: '港湾', intro: '傍晚港口的爵士。' }, ja: { title: '港', intro: '' } }, tags: ['jazz', 'piano'], rating: 4.7 };
    expect((await publicMarket.app.inject({ method: 'POST', url: `${base}/${a.id}/catalog`, headers: support.authHeader, payload: edit })).statusCode).toBe(403);
    const saved = await publicMarket.app.inject({ method: 'POST', url: `${base}/${a.id}/catalog`, headers: admin.authHeader, payload: edit });
    expect(saved.statusCode).toBe(200);
    // A language with neither title nor intro is not stored, so it falls back.
    expect(saved.json()).toMatchObject({ copy: { zh: { title: '港湾', intro: '傍晚港口的爵士。' }, ja: { title: '港', intro: '' } }, tags: ['jazz', 'piano'], rating: 4.7 });
    expect(saved.json().copy.en).toBeUndefined();
    for (const bad of [{ ...edit, rating: 5.5 }, { ...edit, rating: 4.25 }, { ...edit, tags: Array(9).fill('x') }]) {
      expect((await publicMarket.app.inject({ method: 'POST', url: `${base}/${a.id}/catalog`, headers: admin.authHeader, payload: bad })).statusCode).toBe(400);
    }

    // Nothing is public before "publish all", and it needs a reason and an admin.
    expect((await publicMarket.app.inject({ url: '/v1/marketplace/bgm' })).json().items).toEqual([]);
    expect((await publicMarket.app.inject({ method: 'POST', url: `${base}/publish-all`, headers: support.authHeader, payload: { reason: 'All checked by ear' } })).statusCode).toBe(403);
    expect((await publicMarket.app.inject({ method: 'POST', url: `${base}/publish-all`, headers: admin.authHeader, payload: { reason: 'ok' } })).statusCode).toBe(400);
    const all = await publicMarket.app.inject({ method: 'POST', url: `${base}/publish-all`, headers: admin.authHeader, payload: { reason: 'All checked by ear' } });
    expect(all.json()).toEqual({ published: 2, failed: [] });
    const items = (await publicMarket.app.inject({ url: '/v1/marketplace/bgm' })).json().items as Array<{ id: string }>;
    expect(items.map((i) => i.id).sort()).toEqual([a.id, b.id].sort());
    // Each track went through review then publish, each with its own audit row.
    const audit = await publicMarket.app.inject({ url: '/v1/admin/audit?subjectType=official_bgm', headers: admin.authHeader });
    expect(audit.statusCode).toBe(200);
    const { query } = await import('@yuha/db');
    const rows = await query<{ subject_id: string; action: string }>(
      `SELECT subject_id, action FROM audit_logs WHERE subject_type = 'official_bgm' AND action IN ('official_bgm.review','official_bgm.publish')`, []);
    expect(rows.filter((r) => r.subject_id === a.id).map((r) => r.action).sort()).toEqual(['official_bgm.publish', 'official_bgm.review']);
    expect(rows.filter((r) => r.subject_id === b.id)).toHaveLength(2);
    // Run again: nothing left to publish.
    expect((await publicMarket.app.inject({ method: 'POST', url: `${base}/publish-all`, headers: admin.authHeader, payload: { reason: 'All checked by ear' } })).json())
      .toEqual({ published: 0, failed: [] });
    // An edited title is searchable.
    expect((await publicMarket.app.inject({ url: `/v1/marketplace/bgm?q=${encodeURIComponent('港湾')}` })).json().items.map((i: { id: string }) => i.id)).toEqual([a.id]);
  }, 120_000);

  it('starts scores in 3.8–4.5 and reads style tags from the batch', () => {
    expect(startingRating(() => 0)).toBe(3.8);
    expect(startingRating(() => 0.999)).toBe(4.5);
    for (let i = 0; i < 200; i += 1) {
      const r = startingRating();
      expect(r).toBeGreaterThanOrEqual(3.8);
      expect(r).toBeLessThanOrEqual(4.5);
      expect(Math.round(r * 10)).toBe(r * 10);
    }
    expect(officialBgmStyleTags('lo-fi, piano / Chill，lo-fi、')).toEqual(['lo-fi', 'piano', 'Chill']);
    expect(officialBgmStyleTags(null)).toEqual([]);
  });
});
