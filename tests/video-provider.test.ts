/**
 * The video clip contract (docs/AI_SCENE_MV_TICKETS.md, T3): what YUHA may
 * expect of whatever draws a scene MV's shots.
 *
 * One suite, two providers: the demo one development and CI use, and the
 * HTTP one, run against a fake of the dgxv service as the product owner
 * described its API on 2026-11-26 (POST /v1/videos, GET /v1/videos/{id},
 * GET /v1/videos/{id}/content, X-API-Key). That fake is a description, not
 * the service: the response field names in it are the ones the provider
 * guesses, and the first call against the real box is what checks them.
 *
 * No database.
 */
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DemoVideoProvider, HttpVideoProvider, failureCode, type ClipState, type VideoProvider } from '@yuha/providers';

const SHOT = { prompt: 'rain on a neon street, slow dolly', seconds: 1, orientation: 'portrait' as const };

async function settle(p: VideoProvider, id: string): Promise<ClipState> {
  for (let i = 0; i < 200; i += 1) {
    const s = await p.status(id);
    if (s.status !== 'queued' && s.status !== 'running') return s;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('the clip never settled');
}

function streams(file: string): string[] {
  const out = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type:stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return out.stdout.split('\n').filter(Boolean);
}

function contract(name: string, make: () => VideoProvider) {
  describe(`${name}: the clip contract`, () => {
    let p: VideoProvider;
    beforeAll(() => {
      p = make();
    });

    it('draws a silent clip in the orientation asked for, and hands over its bytes', async () => {
      const sub = await p.submit(SHOT);
      if (sub.status !== 'accepted') throw new Error(sub.reason);
      expect((await settle(p, sub.id)).status).toBe('succeeded');
      const bytes = await p.fetchClip(sub.id);
      expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
      const dir = await mkdtemp(join(tmpdir(), 'yuha-clip-'));
      try {
        await writeFile(join(dir, 'c.mp4'), bytes);
        const s = streams(join(dir, 'c.mp4'));
        expect(s).toHaveLength(1); // video only
        const [w, h] = s[0]!.split(',').filter((x) => /^\d+$/.test(x)).map(Number);
        expect(h!).toBeGreaterThan(w!);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 30_000);

    it('refuses what the service cannot draw, without retrying', async () => {
      for (const bad of [{ ...SHOT, seconds: 9 }, { ...SHOT, seconds: 0 }, { ...SHOT, orientation: 'square' as never }, { ...SHOT, prompt: ' ' }]) {
        expect(await p.submit(bad)).toMatchObject({ status: 'rejected', reason: 'invalid_request', retryable: false });
      }
    });

    it('says it does not know a clip it never made, and hands over no bytes for it', async () => {
      expect((await p.status('0123456789abcdef')).status).toBe('unknown');
      await expect(p.fetchClip('0123456789abcdef')).rejects.toThrow();
    });
  });
}

contract('demo', () => new DemoVideoProvider({ delayMs: 20 }));

/** The dgxv service as described: an X-API-Key, and its four routes. */
function fakeDgxv(key: string, opts: { full?: boolean; failWith?: string } = {}) {
  const clips = new Map<string, { polls: number; orientation: string; seconds: number }>();
  const seen: { path: string; key: string | undefined; body?: Record<string, unknown> }[] = [];
  let n = 0;
  const body = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {}));
    });
  const server: Server = createServer(async (req, res) => {
    const json = (code: number, v: unknown) => {
      res.statusCode = code;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(v));
    };
    const url = req.url ?? '';
    const entry: (typeof seen)[number] = { path: `${req.method} ${url}`, key: req.headers['x-api-key'] as string | undefined };
    seen.push(entry);
    if (url === '/health') return json(200, { ok: true, queue: clips.size });
    if (req.headers['x-api-key'] !== key) return json(401, { detail: 'invalid api key' });
    if (req.method === 'POST' && url === '/v1/videos') {
      entry.body = await body(req);
      if (opts.full) return json(429, { detail: 'queue full' });
      const id = `v${(n += 1)}`;
      clips.set(id, { polls: 0, orientation: String(entry.body.orientation), seconds: Number(entry.body.duration) });
      return json(200, { id, status: 'queued' });
    }
    const m = /^\/v1\/videos\/([\w-]+)(\/content)?$/.exec(url);
    const clip = m ? clips.get(m[1]!) : undefined;
    if (!clip) return json(404, { detail: 'not found' });
    if (m![2]) {
      const [w, h] = clip.orientation === 'portrait' ? [288, 512] : [512, 288];
      const out = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${w}x${h}:rate=24`, '-t', String(clip.seconds), '-pix_fmt', 'yuv420p', '-an', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1']);
      res.setHeader('content-type', 'video/mp4');
      return res.end(out.stdout);
    }
    clip.polls += 1;
    if (opts.failWith) return json(200, { id: m![1], status: 'failed', error: opts.failWith });
    return json(200, { id: m![1], status: clip.polls < 2 ? 'queued' : clip.polls < 3 ? 'running' : 'succeeded' });
  });
  return { server, seen, start: () => new Promise<string>((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server.address() as { port: number }).port}`))) };
}

describe('http → the dgxv service, as described', () => {
  const svc = fakeDgxv('test-key');
  let base = '';
  beforeAll(async () => {
    base = await svc.start();
  });
  afterAll(() => {
    svc.server.close();
  });
  const http = (over: Partial<ConstructorParameters<typeof HttpVideoProvider>[0]> = {}) =>
    new HttpVideoProvider({ baseUrl: base, apiKey: 'test-key', allowInsecureLocal: true, ...over });

  contract('http', () => http());

  it('sends the key on every call, a muted request, and the duration in seconds', async () => {
    const sub = await http().submit({ ...SHOT, seconds: 4, orientation: 'landscape' });
    if (sub.status !== 'accepted') throw new Error(sub.reason);
    await settle(http(), sub.id);
    await http().fetchClip(sub.id);
    const mine = svc.seen.filter((s) => s.path.includes('/v1/videos'));
    expect(mine.every((s) => s.key === 'test-key')).toBe(true);
    expect(mine.find((s) => s.body)?.body).toEqual({ prompt: SHOT.prompt, duration: 4, orientation: 'landscape', mute: true });
  }, 30_000);

  it('is refused a plain-http base unless it is local in development, or the box’s public IP by explicit choice', () => {
    expect(() => new HttpVideoProvider({ baseUrl: 'http://video.example.com', apiKey: 'k' })).toThrow(/https/);
    expect(() => new HttpVideoProvider({ baseUrl: 'http://127.0.0.1:8100', apiKey: 'k' })).toThrow(/https/);
    expect(() => new HttpVideoProvider({ baseUrl: 'http://203.0.113.9:8100', apiKey: 'k', allowInsecureLocal: true })).toThrow(/https/);
    expect(() => new HttpVideoProvider({ baseUrl: 'http://203.0.113.9:8100', apiKey: 'k', allowInsecureSelfHosted: true })).not.toThrow();
    // A name can be repointed by DNS; a private address is the other exception's.
    expect(() => new HttpVideoProvider({ baseUrl: 'http://video.example.com', apiKey: 'k', allowInsecureSelfHosted: true })).toThrow(/https/);
    expect(() => new HttpVideoProvider({ baseUrl: 'http://192.168.1.20:8100', apiKey: 'k', allowInsecureSelfHosted: true })).toThrow(/https/);
    expect(() => new HttpVideoProvider({ baseUrl: 'https://video.example.com', apiKey: '' })).toThrow(/VIDEO_API_KEY/);
  });

  it('names a wrong key, an unreachable service and a full queue, rather than throwing', async () => {
    expect(await http({ apiKey: 'wrong' }).submit(SHOT)).toMatchObject({ status: 'rejected', reason: 'unauthorized', retryable: false });
    expect(await http({ apiKey: 'wrong' }).status('v1')).toEqual({ status: 'unknown', reason: 'unauthorized' });
    const gone = new HttpVideoProvider({ baseUrl: 'http://127.0.0.1:9', apiKey: 'k', allowInsecureLocal: true });
    expect(await gone.submit(SHOT)).toMatchObject({ status: 'rejected', reason: 'unavailable', retryable: true });
    expect(await gone.status('v1')).toEqual({ status: 'unknown', reason: 'unreachable' });
    const full = fakeDgxv('k', { full: true });
    const fullBase = await full.start();
    try {
      expect(await new HttpVideoProvider({ baseUrl: fullBase, apiKey: 'k', allowInsecureLocal: true }).submit(SHOT)).toMatchObject({
        status: 'rejected',
        reason: 'queue_full',
        retryable: true,
      });
    } finally {
      full.server.close();
    }
  });

  it('keeps a failure as a code, never the service’s words, which may quote the prompt', async () => {
    const failing = fakeDgxv('k', { failWith: 'CUDA out of memory while drawing "rain on a neon street"' });
    const fBase = await failing.start();
    try {
      const p = new HttpVideoProvider({ baseUrl: fBase, apiKey: 'k', allowInsecureLocal: true });
      const sub = await p.submit(SHOT);
      if (sub.status !== 'accepted') throw new Error(sub.reason);
      expect(await p.status(sub.id)).toEqual({ status: 'failed', reason: 'out_of_memory' });
    } finally {
      failing.server.close();
    }
    expect(failureCode('refused: "rain on a neon street"')).toBe('refused_by_model');
    expect(failureCode('something about rain on a neon street')).toBe('service_failed');
  });
});

describe('demo: limits', () => {
  it('has a bounded queue too, so the pipeline can be tested against a full one', async () => {
    const p = new DemoVideoProvider({ maxQueue: 1, delayMs: 300 });
    expect((await p.submit(SHOT)).status).toBe('accepted');
    expect(await p.submit(SHOT)).toMatchObject({ status: 'rejected', reason: 'queue_full', retryable: true });
  });
});
