/**
 * The photo MV (docs/PHOTO_MV_SPEC.md): the owner's photos on the song's own
 * audio, as a portrait MP4 that is never stored. Off until the privacy text
 * that describes it has been reviewed (docs/legal/PRIVACY_CHANGES_2026-11.md).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimOutboxBatch, jstToday, query, queryOne, statsReport, withTx } from '@yuha/db';
import { runJobStep } from '@yuha/worker/pipeline';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';
import { planPhotoClip } from '../apps/web/src/lib/share-art.js';

let on: Harness;
let off: Harness;

beforeAll(async () => {
  on = await createHarness({ FEATURE_PHOTO_VIDEO_ENABLED: 'true' });
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

async function song(h: Harness, user: TestUser): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `photo-${randomUUID()}` },
    payload: { mode: 'simple', prompt: '海边的傍晚', instrumental: false, durationSeconds: 30 } as never,
  });
  expect(res.statusCode).toBe(202);
  const jobId = res.json().jobId as string;
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 6; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `p-${i}`, log: () => undefined }, jobId);
    const t = await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]);
    if (t) return t.id;
  }
  throw new Error('not delivered');
}

function jpeg(color: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'frame-'));
  const out = join(dir, 'f.jpg');
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${color}:s=720x1280`, '-frames:v', '1', out]);
  return readFileSync(out).toString('base64');
}

function probe(mp4: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), 'probe-'));
  const path = join(dir, 'v.mp4');
  writeFileSync(path, mp4);
  return JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height:format=duration', '-of', 'json', path]).toString(),
  ) as { streams: Array<{ codec_type: string; width?: number; height?: number }>; format: { duration: string } };
}

const leftovers = () => readdirSync(tmpdir()).filter((n) => n.startsWith('yuha-video-'));
// The rights confirmation is part of every request; a test that means to leave it out says so.
const post = (h: Harness, who: TestUser, id: string, body: Record<string, unknown>) =>
  h.app.inject({ method: 'POST', url: `/v1/tracks/${id}/photo-video`, headers: who.authHeader, payload: { rightsConfirmed: true, ...body } as never });

describe('the photo video', () => {
  it('puts the photo frames on the song’s audio as a portrait MP4, and keeps nothing', async () => {
    const user = await on.createUser({ credits: 3 });
    const trackId = await song(on, user);
    const before = leftovers().length;
    const res = await post(on, user, trackId, {
      start: 0,
      duration: 12,
      frames: [
        { at: 0, jpeg: jpeg('0xF46B45') },
        { at: 4, jpeg: jpeg('0x7B66E0') },
        { at: 8, jpeg: jpeg('0x2E8B57') },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    expect(res.headers['cache-control']).toBe('no-store');
    const info = probe(res.rawPayload);
    const video = info.streams.find((s) => s.codec_type === 'video')!;
    expect([video.width, video.height]).toEqual([720, 1280]);
    expect(Number(info.format.duration)).toBeGreaterThan(11.5);
    expect(Number(info.format.duration)).toBeLessThan(12.6);
    // The frames held the photos; the working directory is gone with them.
    expect(leftovers().length).toBe(before);
  }, 60_000);

  it('is counted for the dashboard, cover and photo apart, and records nothing of what was in it', async () => {
    const user = await on.createUser({ credits: 3 });
    const trackId = await song(on, user);
    const frames = [{ at: 0, jpeg: jpeg('0xF46B45') }];
    expect((await post(on, user, trackId, { start: 0, duration: 4, frames })).statusCode).toBe(200);
    const cover = await on.app.inject({
      method: 'POST',
      url: `/v1/tracks/${trackId}/share-video`,
      headers: user.authHeader,
      payload: { start: 0, duration: 4, frames } as never,
    });
    expect(cover.statusCode).toBe(200);
    // A refused one is not a video made.
    expect((await post(on, user, trackId, { start: 0, duration: 4, frames, rightsConfirmed: false })).statusCode).toBe(400);

    const today = jstToday();
    const report = await statsReport({ granularity: 'day', from: today, to: today });
    expect(report.videos).toEqual({ cover: 1, photo: 1 });
    const rows = await query<{ props: string }>(`SELECT props FROM analytics_events WHERE name = 'video_made'`);
    expect(rows).toHaveLength(2);
    for (const r of rows) expect(JSON.stringify(r.props)).not.toMatch(/jpeg|frames|\/9j\//);
  }, 60_000);

  it('is refused while the switch is off', async () => {
    const user = await off.createUser({ credits: 3 });
    const trackId = await song(off, user);
    const res = await post(off, user, trackId, { start: 0, duration: 10, frames: [{ at: 0, jpeg: jpeg('black') }] });
    expect(res.statusCode).toBe(503);
    expect(res.json().code ?? res.json().error?.code).toBe('SERVICE_DISABLED');
  }, 60_000);

  it('is the owner’s alone, takes only JPEG, and stays within its limits', async () => {
    const user = await on.createUser({ credits: 3 });
    const other = await on.createUser();
    const trackId = await song(on, user);
    const frame = { at: 0, jpeg: jpeg('black') };
    expect((await post(on, other, trackId, { start: 0, duration: 10, frames: [frame] })).statusCode).toBe(404);
    expect((await post(on, user, trackId, { start: 0, duration: 10, frames: [{ at: 0, jpeg: 'aGVsbG8=' }] })).statusCode).toBe(400);
    // 30 seconds at most, and inside the song.
    expect((await post(on, user, trackId, { start: 0, duration: 31, frames: [frame] })).statusCode).toBe(400);
    expect((await post(on, user, trackId, { start: 25, duration: 10, frames: [frame] })).statusCode).toBe(400);
    // 40 frames at most.
    const many = Array.from({ length: 41 }, (_, i) => ({ at: i * 0.5, jpeg: frame.jpeg }));
    expect((await post(on, user, trackId, { start: 0, duration: 25, frames: many })).statusCode).toBe(400);
  }, 60_000);

  it('needs the owner to confirm the right to use the photos and the people in them (counsel, 2026-11-24)', async () => {
    const user = await on.createUser({ credits: 3 });
    const trackId = await song(on, user);
    const frame = { at: 0, jpeg: jpeg('black') };
    for (const rightsConfirmed of [undefined, false, 'yes']) {
      const res = await post(on, user, trackId, { start: 0, duration: 10, frames: [frame], rightsConfirmed });
      expect(res.statusCode).toBe(400);
    }
    expect(leftovers()).toEqual([]);
  }, 60_000);

  it('is announced to the web app only when switched on', async () => {
    expect((await off.app.inject({ method: 'GET', url: '/v1/runtime' })).json().features.photoVideoEnabled).toBe(false);
    expect((await on.app.inject({ method: 'GET', url: '/v1/runtime' })).json().features.photoVideoEnabled).toBe(true);
  });

  it('is open to staff while the switch is off, as a preview, and to nobody else', async () => {
    const runtime = async (who?: TestUser) =>
      (await off.app.inject({ method: 'GET', url: '/v1/runtime', headers: who?.authHeader ?? {} })).json().features as {
        photoVideoEnabled: boolean;
        photoVideoPreview?: boolean;
      };
    const admin = await off.createUser({ credits: 3, role: 'admin' });
    const support = await off.createUser({ role: 'support' });
    const user = await off.createUser({ credits: 3 });

    expect(await runtime()).toMatchObject({ photoVideoEnabled: false, photoVideoPreview: false });
    expect(await runtime(user)).toMatchObject({ photoVideoEnabled: false, photoVideoPreview: false });
    expect(await runtime(admin)).toMatchObject({ photoVideoEnabled: true, photoVideoPreview: true });
    expect(await runtime(support)).toMatchObject({ photoVideoEnabled: true, photoVideoPreview: true });

    // Staff make one from their own song; a user is still refused.
    const staffSong = await song(off, admin);
    const made = await post(off, admin, staffSong, { start: 0, duration: 5, frames: [{ at: 0, jpeg: jpeg('black') }] });
    expect(made.statusCode).toBe(200);
    expect(made.headers['content-type']).toContain('video/mp4');
    const userSong = await song(off, user);
    expect((await post(off, user, userSong, { start: 0, duration: 5, frames: [{ at: 0, jpeg: jpeg('black') }] })).statusCode).toBe(503);
    // Staff still only on their own songs: a preview, not an admin tool.
    expect((await post(off, admin, userSong, { start: 0, duration: 5, frames: [{ at: 0, jpeg: jpeg('black') }] })).statusCode).toBe(404);
    // With the public switch on, nobody is told it is a preview.
    expect((await on.app.inject({ method: 'GET', url: '/v1/runtime', headers: admin.authHeader })).json().features.photoVideoPreview).toBe(false);
  }, 90_000);
});

describe('the plan of a photo video', () => {
  const lines = [
    { text: '海が見えた', section: 'verse', start: 10, end: 14 },
    { text: 'きみが笑った', section: 'verse', start: 14, end: 18 },
    { text: 'この夏を', section: 'chorus', start: 30, end: 34 },
    { text: 'ずっと覚えてる', section: 'chorus', start: 34, end: 38 },
    { text: 'さよなら', section: 'outro', start: 60, end: 64 },
  ];

  it('shares the clip out among the photos, in the order chosen', () => {
    const plan = planPhotoClip(lines, 90, 3);
    expect(plan.duration).toBe(30);
    // From just before the chorus, like the share video.
    expect(plan.start).toBe(28.5);
    expect(plan.frames[0]).toMatchObject({ at: 0, photo: 0 });
    const photoAt = (t: number) => [...plan.frames].reverse().find((f) => f.at <= t)!.photo;
    expect([photoAt(1), photoAt(11), photoAt(21)]).toEqual([0, 1, 2]);
  });

  it('changes the line as it is sung, without changing the photo', () => {
    const plan = planPhotoClip(lines, 90, 3);
    const sung = plan.frames.filter((f) => f.line).map((f) => [f.at, f.line, f.photo]);
    expect(sung).toContainEqual([1.5, 'この夏を', 0]);
    expect(sung).toContainEqual([5.5, 'ずっと覚えてる', 0]);
    // A line that has ended leaves the screen.
    expect(plan.frames.find((f) => f.at === 9.5)).toMatchObject({ line: null });
  });

  it('ends on two seconds of the last photo, with the closing frame and nothing sung', () => {
    const plan = planPhotoClip(lines, 90, 3);
    const last = plan.frames.at(-1)!;
    expect(last).toEqual({ at: 28, photo: 2, line: null, ending: true });
    expect(plan.frames.filter((f) => f.ending)).toHaveLength(1);
    // Nothing after the ending begins.
    expect(plan.frames.every((f) => f.at <= 28)).toBe(true);
  });

  it('works for a short instrumental and keeps every frame inside the clip', () => {
    const plan = planPhotoClip([], 20, 5);
    expect(plan.duration).toBe(15);
    expect(new Set(plan.frames.map((f) => f.photo))).toEqual(new Set([0, 1, 2, 3, 4]));
    for (const f of plan.frames) expect(f.at).toBeLessThan(plan.duration);
    expect(plan.frames.length).toBeLessThanOrEqual(40);
  });
});

describe('frames a crashed encode left behind (docs/legal/PRIVACY_CHANGES_2026-11.md)', () => {
  it('are swept after an hour; a directory still in use, and anything else in /tmp, are left alone', async () => {
    const { sweepStaleVideoDirs } = await import('../apps/api/src/services/share-video.js');
    const { mkdirSync, utimesSync, existsSync } = await import('node:fs');
    const root = mkdtempSync(join(tmpdir(), 'sweep-root-'));
    const stale = join(root, 'yuha-video-stale');
    const fresh = join(root, 'yuha-video-fresh');
    const other = join(root, 'someone-elses');
    for (const d of [stale, fresh, other]) mkdirSync(d);
    writeFileSync(join(stale, 'f000.jpg'), 'photo');
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(stale, twoHoursAgo, twoHoursAgo);
    utimesSync(other, twoHoursAgo, twoHoursAgo);

    expect(await sweepStaleVideoDirs({ root })).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });
});
