/**
 * The video clip contract (docs/AI_SCENE_MV_TICKETS.md, T3): what YUHA may
 * expect of whatever draws a scene MV's shots.
 *
 * One suite, two providers. The demo one is what development and CI use; the
 * HTTP one is run against the real clip service from deploy/dgx/video — the
 * Python app itself, on its fake backend — not against a TypeScript imitation
 * of it, so a change on either side that breaks the other fails here.
 *
 * That needs Python with fastapi/uvicorn. In CI their absence is a failure
 * (the workflow installs them); on a laptop without them the HTTP half is
 * skipped and says so, and the demo half still runs.
 *
 * No database.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DemoVideoProvider, HttpVideoProvider, type ClipState, type VideoProvider } from '@yuha/providers';

const PY = process.env.VIDEO_TEST_PYTHON ?? 'python3';
const hasPython = spawnSync(PY, ['-c', 'import fastapi, uvicorn, httpx'], { stdio: 'ignore' }).status === 0;
if (!hasPython && process.env.CI) throw new Error(`${PY} cannot import fastapi/uvicorn/httpx; the CI workflow installs them before the tests`);
if (!hasPython) console.warn(`[video-provider] ${PY} lacks fastapi/uvicorn/httpx: the HTTP contract half is skipped`);

const SHOT = { prompt: 'rain on a neon street, slow dolly', width: 256, height: 448, seconds: 1, fps: 8 };
const key = () => `k-${Math.random().toString(36).slice(2)}`;

async function settle(p: VideoProvider, id: string): Promise<ClipState> {
  for (let i = 0; i < 200; i += 1) {
    const s = await p.status(id);
    if (s.status !== 'queued' && s.status !== 'running') return s;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the clip never settled');
}

function streams(file: string): string[] {
  const out = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  return out.stdout.split('\n').filter(Boolean);
}

function contract(name: string, make: () => VideoProvider) {
  describe(`${name}: the clip contract`, () => {
    let p: VideoProvider;
    beforeAll(() => {
      p = make();
    });

    it('draws a silent clip of the shape asked for, and hands over its bytes', async () => {
      const sub = await p.submit({ ...SHOT, idempotencyKey: key() });
      expect(sub.status).toBe('accepted');
      if (sub.status !== 'accepted') return;
      const done = await settle(p, sub.id);
      expect(done.status).toBe('succeeded');
      if (done.status === 'succeeded') expect(done.clipSeconds).toBeGreaterThan(0);
      const bytes = await p.fetchClip(sub.id);
      expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
      const dir = await mkdtemp(join(tmpdir(), 'yuha-clip-'));
      try {
        await writeFile(join(dir, 'c.mp4'), bytes);
        expect(streams(join(dir, 'c.mp4'))).toEqual(['video']);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }, 30_000);

    it('takes a repeat with the same key as the same clip, and refuses the key for a different one', async () => {
      const k = key();
      const a = await p.submit({ ...SHOT, idempotencyKey: k });
      const b = await p.submit({ ...SHOT, idempotencyKey: k });
      expect(a.status === 'accepted' && b.status === 'accepted' && a.id === b.id).toBe(true);
      const c = await p.submit({ ...SHOT, seed: 7, idempotencyKey: k });
      expect(c).toMatchObject({ status: 'rejected', reason: 'idempotency_key_reused', retryable: false });
      if (a.status === 'accepted') await settle(p, a.id);
    }, 30_000);

    it('refuses a shape it cannot draw, without retrying', async () => {
      const r = await p.submit({ ...SHOT, width: 250, idempotencyKey: key() });
      expect(r).toMatchObject({ status: 'rejected', reason: 'invalid_request', retryable: false });
    });

    it('cancels a clip and never hands over bytes for it', async () => {
      const sub = await p.submit({ ...SHOT, seconds: 2, idempotencyKey: key() });
      if (sub.status !== 'accepted') throw new Error(sub.reason);
      await p.cancel(sub.id);
      expect((await settle(p, sub.id)).status).toBe('cancelled');
      await expect(p.fetchClip(sub.id)).rejects.toThrow();
    }, 30_000);

    it('says it does not know a clip it never made', async () => {
      expect((await p.status('0123456789abcdef0123456789abcdef')).status).toBe('unknown');
    });
  });
}

contract('demo', () => new DemoVideoProvider());

describe.skipIf(!hasPython)('http', () => {
  let svc: ChildProcess;
  let data: string;
  const port = 18_100 + Math.floor(Math.random() * 500);
  const base = `http://127.0.0.1:${port}`;
  const http = (over: Partial<ConstructorParameters<typeof HttpVideoProvider>[0]> = {}) =>
    new HttpVideoProvider({ baseUrl: base, apiKey: 'test-key', allowInsecureLocal: true, ...over });

  beforeAll(async () => {
    data = await mkdtemp(join(tmpdir(), 'yuha-video-svc-'));
    svc = spawn(PY, ['-m', 'uvicorn', 'app:app', '--port', String(port), '--log-level', 'warning'], {
      cwd: join(process.cwd(), 'deploy/dgx/video/server'),
      env: { ...process.env, DATA_DIR: data, VIDEO_BACKEND: 'fake', FAKE_DELAY_SECONDS: '0.3', YUHA_API_KEY: 'test-key', CLIP_BASE_URL: base },
      stdio: 'ignore',
    });
    for (let i = 0; i < 100; i += 1) {
      try {
        if ((await fetch(`${base}/healthz`)).ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('the clip service did not start');
  }, 30_000);
  afterAll(async () => {
    svc?.kill();
    await rm(data, { recursive: true, force: true });
  });

  contract('http → deploy/dgx/video', () => http());

  it('is refused a plain-http base anywhere but this machine', () => {
    expect(() => new HttpVideoProvider({ baseUrl: 'http://video.example.com', apiKey: 'k' })).toThrow(/https/);
    expect(() => new HttpVideoProvider({ baseUrl: 'http://203.0.113.9:8100', apiKey: 'k', allowInsecureLocal: true })).toThrow(/https/);
    expect(() => new HttpVideoProvider({ baseUrl: 'http://127.0.0.1:8100', apiKey: 'k' })).toThrow(/https/);
  });

  it('names a wrong key, and an unreachable service, rather than throwing', async () => {
    expect(await http({ apiKey: 'wrong' }).submit({ ...SHOT, idempotencyKey: key() })).toMatchObject({
      status: 'rejected',
      reason: 'unauthorized',
      retryable: false,
    });
    const gone = new HttpVideoProvider({ baseUrl: 'http://127.0.0.1:9', apiKey: 'k', allowInsecureLocal: true });
    expect(await gone.submit({ ...SHOT, idempotencyKey: key() })).toMatchObject({ status: 'rejected', reason: 'unavailable', retryable: true });
    expect(await gone.status('0123456789abcdef0123456789abcdef')).toMatchObject({ status: 'unknown', reason: 'unreachable' });
  });

  it('fetches a clip only from the service it asked, whatever link comes back', async () => {
    // A service that answers with a link somewhere else: the bytes are never fetched.
    let hits = 0;
    const elsewhere: Server = createServer((req, res) => {
      hits += 1;
      res.end('x');
    });
    await new Promise<void>((r) => elsewhere.listen(0, '127.0.0.1', r));
    const other = (elsewhere.address() as { port: number }).port;
    const liar: Server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ id: 'a', status: 'succeeded', clip_url: `http://localhost:${other}/v1/files/a.mp4`, clip_seconds: 1 }));
    });
    await new Promise<void>((r) => liar.listen(0, '127.0.0.1', r));
    const liarBase = `http://127.0.0.1:${(liar.address() as { port: number }).port}`;
    try {
      const p = new HttpVideoProvider({ baseUrl: liarBase, apiKey: 'k', allowInsecureLocal: true });
      await expect(p.fetchClip('a')).rejects.toThrow(/allow-list|not allowed/);
      expect(hits).toBe(0);
    } finally {
      liar.close();
      elsewhere.close();
    }
  });

  it('tells the queue being full apart from a refusal', async () => {
    const svcFull: Server = createServer((req, res) => {
      res.statusCode = 429;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'rejected', error: 'queue_full', detail: '8 clips waiting' }));
    });
    await new Promise<void>((r) => svcFull.listen(0, '127.0.0.1', r));
    try {
      const p = new HttpVideoProvider({ baseUrl: `http://127.0.0.1:${(svcFull.address() as { port: number }).port}`, apiKey: 'k', allowInsecureLocal: true });
      expect(await p.submit({ ...SHOT, idempotencyKey: key() })).toMatchObject({ status: 'rejected', reason: 'queue_full', retryable: true });
    } finally {
      svcFull.close();
    }
  });
});

describe('demo: limits', () => {
  it('has a bounded queue too, so the pipeline can be tested against a full one', async () => {
    const p = new DemoVideoProvider({ maxQueue: 1, delayMs: 300 });
    expect((await p.submit({ ...SHOT, idempotencyKey: key() })).status).toBe('accepted');
    expect(await p.submit({ ...SHOT, idempotencyKey: key() })).toMatchObject({ status: 'rejected', reason: 'queue_full', retryable: true });
  });
});
