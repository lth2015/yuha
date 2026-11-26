/**
 * Veo 3.1 through TokenStars (docs/VEO_VIA_TOKENSTARS.md; the Veo spec's V1).
 *
 * Against a fake of TokenStars' documented async video API, not the real one:
 * nothing here spends money. Pinned: the request is always the cheap one the
 * spec allows (the configured Veo model, 720p, 9:16, no generated audio, a
 * duration Veo accepts) whatever the caller asks; a submit whose fate is
 * unknown is reported as such, never as "try again"; failures are codes; the
 * clip is fetched only from TokenStars.
 */
import { spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TokenStarsVeoProvider } from '@yuha/providers';

const KEY = 'sk-test';
const SHOT = { prompt: 'rain on a neon street, slow dolly', seconds: 8, orientation: 'portrait' as const };

function fakeTokenStars(opts: { hang?: boolean; failWith?: string; status?: number } = {}) {
  const tasks = new Map<string, { polls: number }>();
  const seen: { method: string; url: string; auth?: string; body?: Record<string, unknown> }[] = [];
  let n = 0;
  const readBody = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {}));
    });
  let base = '';
  const server: Server = createServer(async (req, res) => {
    const json = (code: number, v: unknown) => {
      res.statusCode = code;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(v));
    };
    const entry: (typeof seen)[number] = { method: req.method!, url: req.url!, auth: req.headers.authorization };
    seen.push(entry);
    if (req.headers.authorization !== `Bearer ${KEY}`) return json(401, { error: { message: 'invalid key' } });
    if (req.method === 'GET' && req.url === '/v1/models') return json(200, { data: [] });
    if (req.method === 'POST' && req.url === '/v1/video/generations') {
      entry.body = await readBody(req);
      if (opts.hang) return; // never answers: the submit's fate is unknown
      if (opts.status) return json(opts.status, { error: { message: 'nope' } });
      const id = `task_${(n += 1)}`;
      tasks.set(id, { polls: 0 });
      return json(200, { id, task_id: id, object: 'video', status: 'queued', progress: 0 });
    }
    const poll = /^\/v1\/video\/generations\/([\w-]+)$/.exec(req.url ?? '');
    if (req.method === 'GET' && poll) {
      const t = tasks.get(poll[1]!);
      if (!t) return json(404, { error: { message: 'not found' } });
      t.polls += 1;
      if (opts.failWith) return json(200, { code: 'success', data: { task_id: poll[1], status: 'failed', error: opts.failWith } });
      const status = t.polls < 2 ? 'queued' : t.polls < 3 ? 'processing' : 'succeeded';
      return json(200, { code: 'success', data: { task_id: poll[1], status, error: null, format: 'mp4', url: status === 'succeeded' ? `${base}/v1/videos/${poll[1]}/content` : null } });
    }
    const content = /^\/v1\/videos\/([\w-]+)\/content$/.exec(req.url ?? '');
    if (req.method === 'GET' && content && tasks.has(content[1]!)) {
      const out = spawnSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=24', '-t', '1', '-pix_fmt', 'yuv420p', '-an', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1']);
      res.setHeader('content-type', 'video/mp4');
      return res.end(out.stdout);
    }
    json(404, {});
  });
  return {
    seen,
    server,
    start: () =>
      new Promise<string>((r) =>
        server.listen(0, '127.0.0.1', () => {
          base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
          r(base);
        }),
      ),
  };
}

const veo = (baseUrl: string, over: Record<string, unknown> = {}) =>
  new TokenStarsVeoProvider({ baseUrl, apiKey: KEY, model: 'veo-3.1-fast-generate-001', allowInsecureLocal: true, timeoutMs: 1500, ...over });

async function settle(p: TokenStarsVeoProvider, id: string) {
  for (let i = 0; i < 50; i += 1) {
    const s = await p.status(id);
    if (s.status !== 'queued' && s.status !== 'running') return s;
  }
  throw new Error('never settled');
}

describe('Veo through TokenStars', () => {
  const svc = fakeTokenStars();
  let base = '';
  beforeAll(async () => {
    base = await svc.start();
  });
  afterAll(() => svc.server.close());

  it('asks for exactly the cheap clip the spec allows, with the key, and hands back its bytes', async () => {
    const p = veo(base);
    // Whatever the caller asks for, the request is locked: 720p, 9:16, no audio, the configured model.
    const sub = await p.submit({ ...SHOT, orientation: 'landscape' as never });
    if (sub.status !== 'accepted') throw new Error(sub.reason);
    expect(svc.seen.find((s) => s.body)?.body).toEqual({
      model: 'veo-3.1-fast-generate-001',
      prompt: SHOT.prompt,
      size: '720p',
      aspect_ratio: '9:16',
      duration: 8,
      generate_audio: false,
    });
    expect(svc.seen.every((s) => s.auth === `Bearer ${KEY}`)).toBe(true);
    expect((await p.status(sub.id)).status).toBe('queued');
    expect((await p.status(sub.id)).status).toBe('running'); // 'processing'
    expect((await settle(p, sub.id)).status).toBe('succeeded');
    const bytes = await p.fetchClip(sub.id);
    expect(bytes.subarray(4, 8).toString('latin1')).toBe('ftyp');
  });

  it('takes only the durations Veo draws, and says which', () => {
    expect(veo(base).durations).toEqual([4, 6, 8]);
  });

  it('refuses a duration Veo does not draw, before spending anything', async () => {
    const before = svc.seen.length;
    expect(await veo(base).submit({ ...SHOT, seconds: 7 })).toMatchObject({ status: 'rejected', reason: 'invalid_request', retryable: false });
    expect(svc.seen.length).toBe(before);
  });

  it('only runs the models the product owner enabled', () => {
    expect(() => veo(base, { model: 'veo-3.1-generate-001' })).toThrow(/VEO_MODEL/);
    expect(() => veo(base, { model: 'veo-3.1-lite-generate-001' })).not.toThrow();
  });

  it('says it is not sure, rather than "try again", when a submit goes unanswered', async () => {
    const hanging = fakeTokenStars({ hang: true });
    const hb = await hanging.start();
    try {
      // It may have been accepted, and charged: resubmitting could pay twice.
      expect(await veo(hb).submit(SHOT)).toMatchObject({ status: 'rejected', reason: 'uncertain', retryable: false });
    } finally {
      hanging.server.closeAllConnections();
      hanging.server.close();
    }
  });

  it('names a refusal, a full balance, a wrong key and a busy service', async () => {
    for (const [code, reason, retryable] of [
      [400, 'invalid_request', false],
      [401, 'unauthorized', false],
      [402, 'unavailable', false],
      [403, 'unauthorized', false],
      [429, 'queue_full', true],
      [503, 'unavailable', true],
    ] as const) {
      const s = fakeTokenStars({ status: code });
      const b = await s.start();
      try {
        expect(await veo(b).submit(SHOT), String(code)).toMatchObject({ status: 'rejected', reason, retryable });
      } finally {
        s.server.close();
      }
    }
  });

  it('keeps a failure as a code — a safety refusal included — never the words', async () => {
    const s = fakeTokenStars({ failWith: 'SafetyFilterActivated: prompt violates content policy ("rain on a neon street")' });
    const b = await s.start();
    try {
      const p = veo(b);
      const sub = await p.submit(SHOT);
      if (sub.status !== 'accepted') throw new Error(sub.reason);
      expect(await p.status(sub.id)).toEqual({ status: 'failed', reason: 'refused_by_model' });
    } finally {
      s.server.close();
    }
  });

  it('fetches a clip only from TokenStars, and checks health without generating anything', async () => {
    const p = veo(base);
    await expect(p.fetchClip('task_nope')).rejects.toThrow();
    const before = svc.seen.filter((x) => x.method === 'POST').length;
    expect(await p.health()).toEqual({ ok: true, queued: null });
    expect(svc.seen.filter((x) => x.method === 'POST').length).toBe(before);
    expect(() => new TokenStarsVeoProvider({ baseUrl: 'http://www.tokenstars.ai', apiKey: KEY, model: 'veo-3.1-fast-generate-001' })).toThrow(/https/);
  });
});
