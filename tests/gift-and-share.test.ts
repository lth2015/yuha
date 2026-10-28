/**
 * A song for somebody, and a link that looks like the song when it is shared
 * (docs/GIFT_AND_SHARE_SPEC.md).
 *
 * Pinned here: who the song is for reaches the lyric writer and stays on the
 * song; it is screened before anything is spent, because it is shown to
 * anybody holding the link; the share link answers a person with the song's
 * page and a preview crawler with the song's own title and picture — and a
 * private song's title never reaches a crawler at all.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claimOutboxBatch, getBalance, queryOne, withTx } from '@yuha/db';
import type { TextProvider } from '@yuha/providers';
import { runJobStep } from '@yuha/worker/pipeline';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let prompts: string[] = [];

beforeAll(async () => {
  h = await createHarness();
  // Record what the lyric writer is asked, without changing what it answers.
  const text = h.ctx.text as TextProvider;
  const extract = text.extractIntent.bind(text);
  text.extractIntent = async (req) => {
    prompts.push(req.prompt);
    return extract(req);
  };
});
beforeEach(async () => {
  await resetData();
  prompts = [];
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

const BOT = 'Twitterbot/1.0';
const PERSON = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const dedication = { to: '小林', occasion: 'birthday', note: '谢谢你一直在', lang: 'zh' } as const;

async function song(user: TestUser, body: Record<string, unknown> = {}) {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `gift-${randomUUID()}` },
    payload: { mode: 'simple', prompt: '秋天的傍晚', instrumental: false, durationSeconds: 30, ...body } as never,
  });
  if (res.statusCode !== 202) return { res, trackId: null as string | null };
  const jobId = res.json().jobId as string;
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 6; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `g-${i}`, log: () => undefined }, jobId);
    const t = await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]);
    if (t) return { res, trackId: t.id };
  }
  throw new Error('not delivered');
}

/** The smallest bytes the card check accepts: a PNG signature and an IHDR of the given size. */
function png(width: number, height: number): string {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b.toString('base64');
}

const share = (id: string, ua: string) =>
  h.app.inject({ method: 'GET', url: `/v1/share/songs/${id}`, headers: { 'user-agent': ua } });

const publish = (user: TestUser, id: string) =>
  h.app.inject({ method: 'POST', url: `/v1/tracks/${id}/visibility`, headers: user.authHeader, payload: { visibility: 'public' } as never });

describe('a song for somebody', () => {
  it('tells the lyric writer who it is for, in the creator’s language, and keeps it on the song', async () => {
    const user = await h.createUser({ credits: 3 });
    const { trackId } = await song(user, { dedication });
    expect(prompts.at(-1)).toContain('小林');
    expect(prompts.at(-1)).toContain('生日');
    expect(prompts.at(-1)).toContain('谢谢你一直在');

    const view = await h.app.inject({ method: 'GET', url: `/v1/tracks/${trackId}`, headers: user.authHeader });
    expect(view.json().dedication).toEqual(dedication);
  });

  it('needs no description of its own: who and why is enough', async () => {
    const user = await h.createUser({ credits: 3 });
    const { res } = await song(user, { prompt: '', dedication: { to: 'Mika', occasion: 'thanks', lang: 'en' } });
    expect(res.statusCode).toBe(202);
    expect(prompts.at(-1)).toBe('A song for Mika, for saying thank you.');
  });

  it('screens the name and the note before anything is spent', async () => {
    const user = await h.createUser({ credits: 3 });
    const { res } = await song(user, { dedication: { ...dedication, note: '打给我 090-1234-5678' } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('PROMPT_BLOCKED');
    expect(res.json().error.details.field).toBe('dedication.note');
    expect((await getBalance(user.id)).available).toBe(3);
  });
});

describe('the share link', () => {
  it('sends a person to the song’s page', async () => {
    const user = await h.createUser({ credits: 3 });
    const { trackId } = await song(user, { dedication });
    await publish(user, trackId!);
    const res = await share(trackId!, PERSON);
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${h.ctx.config.PUBLIC_WEB_URL}/song/${trackId}`);
    expect(res.headers['cache-control']).toContain('no-store');
  });

  it('shows a crawler the song: who it is for, its picture, and itself as the canonical url', async () => {
    const user = await h.createUser({ credits: 3 });
    const { trackId } = await song(user, { dedication });
    await publish(user, trackId!);
    const up = await h.app.inject({
      method: 'PUT',
      url: `/v1/tracks/${trackId}/share-card`,
      headers: user.authHeader,
      payload: { png: png(1200, 630) } as never,
    });
    expect(up.statusCode).toBe(200);

    const res = await share(trackId!, BOT);
    expect(res.statusCode).toBe(200);
    const html = res.body;
    expect(html).toMatch(/<meta property="og:title" content="写给小林的一首歌《[^"]+》">/);
    expect(html).toContain('<meta property="og:description" content="生日快乐 · 谢谢你一直在">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toMatch(new RegExp(`og:image" content="[^"]+/v1/share/songs/${trackId}/card\\.png\\?v=[0-9a-f]{10}"`));
    expect(html).toContain(`<meta property="og:url" content="${h.ctx.config.PUBLIC_API_URL}/v1/share/songs/${trackId}">`);

    const img = await h.app.inject({ method: 'GET', url: `/v1/share/songs/${trackId}/card.png` });
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.rawPayload.toString('base64')).toBe(png(1200, 630));
  });

  it('never shows a crawler a private song’s title or picture', async () => {
    const user = await h.createUser({ credits: 3 });
    const { trackId } = await song(user, { dedication, title: '只给自己听的歌' });
    await h.app.inject({ method: 'PUT', url: `/v1/tracks/${trackId}/share-card`, headers: user.authHeader, payload: { png: png(1200, 630) } as never });

    const res = await share(trackId!, BOT);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('只给自己听的歌');
    expect(res.body).not.toContain('小林');
    expect(res.body).toContain(`${h.ctx.config.PUBLIC_WEB_URL}/brand/og-card.png`);

    const img = await h.app.inject({ method: 'GET', url: `/v1/share/songs/${trackId}/card.png` });
    expect(img.statusCode).toBe(302);
    expect(img.headers.location).toBe(`${h.ctx.config.PUBLIC_WEB_URL}/brand/og-card.png`);
  });

  it('escapes a title that tries to write markup into the page', async () => {
    const user = await h.createUser({ credits: 3 });
    const { trackId } = await song(user, { title: '"><script>x</script>' });
    await publish(user, trackId!);
    const res = await share(trackId!, BOT);
    expect(res.body).not.toContain('<script>');
    expect(res.body).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('takes a card only from the owner, only as a 1200×630 PNG', async () => {
    const user = await h.createUser({ credits: 3 });
    const other = await h.createUser();
    const { trackId } = await song(user);
    const put = (who: TestUser, b64: string) =>
      h.app.inject({ method: 'PUT', url: `/v1/tracks/${trackId}/share-card`, headers: who.authHeader, payload: { png: b64 } as never });
    expect((await put(other, png(1200, 630))).statusCode).toBe(404);
    expect((await put(user, png(800, 800))).statusCode).toBe(400);
    expect((await put(user, Buffer.from('GIF89a not a png at all').toString('base64'))).statusCode).toBe(400);
    expect((await put(user, png(1200, 630))).statusCode).toBe(200);
  });
});

/** A real 720×1280 JPEG of one colour, made by ffmpeg like the frames a browser sends. */
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

describe('the share video', () => {
  const post = (who: TestUser, id: string, body: unknown) =>
    h.app.inject({ method: 'POST', url: `/v1/tracks/${id}/share-video`, headers: who.authHeader, payload: body as never });

  it('puts the owner’s frames on the song’s own audio, as a portrait MP4', async () => {
    const user = await h.createUser({ credits: 3 });
    const { trackId } = await song(user, { dedication });
    const res = await post(user, trackId!, {
      start: 4,
      duration: 6,
      frames: [
        { at: 0, jpeg: jpeg('0xF46B45') },
        { at: 2.5, jpeg: jpeg('0x7B66E0') },
      ],
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
    const info = probe(res.rawPayload);
    expect(info.streams.map((s) => s.codec_type).sort()).toEqual(['audio', 'video']);
    const video = info.streams.find((s) => s.codec_type === 'video')!;
    expect([video.width, video.height]).toEqual([720, 1280]);
    expect(Number(info.format.duration)).toBeGreaterThan(5.5);
    expect(Number(info.format.duration)).toBeLessThan(6.6);
  }, 60_000);

  it('is the owner’s, takes only JPEG frames, and stays inside the song', async () => {
    const user = await h.createUser({ credits: 3 });
    const other = await h.createUser();
    const { trackId } = await song(user);
    const frames = [{ at: 0, jpeg: jpeg('black') }];
    expect((await post(other, trackId!, { start: 0, duration: 5, frames })).statusCode).toBe(404);
    expect((await post(user, trackId!, { start: 0, duration: 5, frames: [{ at: 0, jpeg: png(720, 1280) }] })).statusCode).toBe(400);
    expect((await post(user, trackId!, { start: 28, duration: 10, frames })).statusCode).toBe(400);
  }, 60_000);
});

describe('what a gift keeps private', () => {
  it('is never on the home page showcase, name or note', async () => {
    const user = await h.createUser({ credits: 3 });
    const { trackId: gift } = await song(user, { dedication });
    const { trackId: plain } = await song(user);
    await publish(user, gift!);
    await publish(user, plain!);
    const res = await h.app.inject({ method: 'GET', url: '/v1/explore' });
    const ids = res.json().items.map((i: { trackId: string }) => i.trackId);
    expect(ids).toContain(plain);
    expect(ids).not.toContain(gift);
    expect(res.body).not.toContain('小林');
    expect(res.json().items.every((i: { dedication: unknown }) => i.dedication === null)).toBe(true);
  });

  it('opens for a person reading inside LINE, and is previewed for LINE’s own crawler', async () => {
    const user = await h.createUser({ credits: 3 });
    const { trackId } = await song(user, { dedication });
    await publish(user, trackId!);
    const inApp = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari Line/14.12.0';
    expect((await share(trackId!, inApp)).statusCode).toBe(302);
    const crawler = await share(trackId!, 'facebookexternalhit/1.1;line-poker/1.0');
    expect(crawler.statusCode).toBe(200);
    expect(crawler.body).toContain('写给小林的一首歌');
  });

  it('goes with the song when the song is deleted: the name, the note and the card', async () => {
    const user = await h.createUser({ credits: 3 });
    const { trackId } = await song(user, { dedication });
    await h.app.inject({ method: 'PUT', url: `/v1/tracks/${trackId}/share-card`, headers: user.authHeader, payload: { png: png(1200, 630) } as never });
    const del = await h.app.inject({ method: 'DELETE', url: `/v1/tracks/${trackId}`, headers: user.authHeader });
    expect(del.statusCode).toBe(204);
    const row = await queryOne<{ dedication: unknown }>(`SELECT dedication FROM tracks WHERE id = ?`, [trackId]);
    expect(row!.dedication).toBeNull();
    expect(await queryOne(`SELECT track_id FROM share_cards WHERE track_id = ?`, [trackId])).toBeUndefined();
    await expect(h.ctx.storage.get('delivery', `share-cards/${user.id}/${trackId}.png`)).rejects.toThrow();
  });

  it('serves the card to nobody’s cache, so unpublishing takes it down', async () => {
    const user = await h.createUser({ credits: 3 });
    const { trackId } = await song(user, { dedication });
    await publish(user, trackId!);
    await h.app.inject({ method: 'PUT', url: `/v1/tracks/${trackId}/share-card`, headers: user.authHeader, payload: { png: png(1200, 630) } as never });
    const img = await h.app.inject({ method: 'GET', url: `/v1/share/songs/${trackId}/card.png` });
    expect(img.headers['cache-control']).toBe('private, no-store');
  });
});
