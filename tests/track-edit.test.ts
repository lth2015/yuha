/**
 * POST /v1/tracks/:id/edit — "AI 再创作": a new song from a finished one.
 *
 * It used to take only a description of the change, so the creator could not
 * see or touch the lyrics they were changing, and none of the lyric tools
 * the studio has were there. It now also takes the lyrics as the creator left
 * them: their words win over the model's, a lyrics-only change needs no
 * description, and a request that changes nothing is refused before anything
 * is spent.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { claimOutboxBatch, getBalance, getJob, query, queryOne, withTx } from '@yuha/db';
import type { ReviseResult, TextProvider } from '@yuha/providers';
import { runJobStep } from '@yuha/worker/pipeline';
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

const LYRICS = '[verse]\n晚风吹过湖面\n灯一盏一盏亮起\n\n[chorus]\n慢慢地 慢慢地';
let keyN = 0;
const key = () => `edit-test-key-${++keyN}-${Date.now()}`;

/** A finished song with the given lyrics, made the way the worker makes them. */
async function song(user: TestUser, opts: { instrumental?: boolean } = {}): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': key() },
    payload: (opts.instrumental
      ? { mode: 'simple', prompt: '湖边的晚风', styles: ['chill'], instrumental: true, durationSeconds: 60 }
      : { mode: 'custom', prompt: '湖边的晚风', lyrics: LYRICS, styles: ['chill'], instrumental: false, durationSeconds: 60 }) as never,
  });
  expect(res.statusCode).toBe(202);
  const jobId = res.json().jobId as string;
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 6; i += 1) {
    const job = await getJob(jobId);
    if (job?.state === 'DELIVERED') break;
    await runJobStep({ ctx: h.ctx, owner: `edit-${i}`, log: () => undefined }, jobId);
  }
  return (await queryOne<{ id: string }>('SELECT id FROM tracks WHERE job_id = ?', [jobId]))!.id;
}

const edit = (user: TestUser, trackId: string, body: Record<string, unknown>) =>
  h.app.inject({
    method: 'POST',
    url: `/v1/tracks/${trackId}/edit`,
    headers: { ...user.authHeader, 'idempotency-key': key() },
    payload: body as never,
  });

const inputOf = async (jobId: string) => {
  const row = await queryOne<{ input: unknown }>('SELECT input FROM generation_jobs WHERE id = ?', [jobId]);
  return (typeof row!.input === 'string' ? JSON.parse(row!.input) : row!.input) as { lyrics?: string; prompt: string; title?: string; styles: string[] };
};

async function withRevise<T>(reviseSong: TextProvider['reviseSong'], run: () => Promise<T>): Promise<T> {
  const real = h.ctx.text;
  (h.ctx as { text: TextProvider }).text = { ...real, providerId: real.providerId, model: real.model, extractIntent: real.extractIntent.bind(real), reviseSong } as TextProvider;
  try {
    return await run();
  } finally {
    (h.ctx as { text: TextProvider }).text = real;
  }
}

describe('AI re-create', () => {
  it('still works from a description alone', async () => {
    const user = await h.createUser({ credits: 3 });
    const trackId = await song(user);
    const res = await edit(user, trackId, { instructions: '更欢快一点' });
    expect(res.statusCode).toBe(202);
    expect((await inputOf(res.json().jobId)).prompt).toBe('更欢快一点');
  }, 60_000);

  it('takes the lyrics as the creator left them, without a description', async () => {
    const user = await h.createUser({ credits: 3 });
    const trackId = await song(user);
    const mine = LYRICS.replace('灯一盏一盏亮起', '路灯一盏一盏地亮');
    let revised = 0;
    const res = await withRevise(async () => ((revised += 1), { status: 'failed', reason: 'unused', usage: { costMinor: 0, costIsEstimate: true } } as ReviseResult), () =>
      edit(user, trackId, { instructions: '', lyrics: mine }),
    );
    expect(res.statusCode).toBe(202);
    const input = await inputOf(res.json().jobId);
    expect(input.lyrics).toBe(mine);
    // Nothing to ask the model: the title, styles and description carry over.
    expect(revised).toBe(0);
    expect(input.prompt).toBe('湖边的晚风');
    expect(input.styles).toEqual(['chill']);
  }, 60_000);

  it('keeps the creator\'s lyrics when a description is given too: their words win over the model\'s', async () => {
    const user = await h.createUser({ credits: 3 });
    const trackId = await song(user);
    const mine = LYRICS.replace('慢慢地 慢慢地', '轻轻地 轻轻地');
    let seen: string | null = null;
    const res = await withRevise(
      async (req) => {
        seen = req.original.lyrics;
        return { status: 'ok', title: '新标题', styles: ['pop'], lyrics: '[verse]\n模型自己写的', usage: { costMinor: 0, costIsEstimate: true } };
      },
      () => edit(user, trackId, { instructions: '换成流行风', lyrics: mine }),
    );
    expect(res.statusCode).toBe(202);
    // The model was shown the creator's version, not the old one...
    expect(seen).toBe(mine);
    const input = await inputOf(res.json().jobId);
    // ...and what is sung is still theirs; the description changed the rest.
    expect(input.lyrics).toBe(mine);
    expect(input.styles).toEqual(['pop']);
    expect(input.title).toBe('新标题');
  }, 60_000);

  it('refuses a request that changes nothing, before anything is spent', async () => {
    const user = await h.createUser({ credits: 3 });
    const trackId = await song(user);
    const before = (await getBalance(user.id)).available;
    for (const body of [{ instructions: '' }, { instructions: '  ', lyrics: LYRICS }, { lyrics: LYRICS }]) {
      const res = await edit(user, trackId, body);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_FAILED');
    }
    expect((await getBalance(user.id)).available).toBe(before);
    const jobs = await query<{ n: number }>('SELECT COUNT(*) AS n FROM generation_jobs WHERE user_id = ?', [user.id]);
    expect(Number(jobs[0]!.n)).toBe(1);
  }, 60_000);

  it('screens the creator\'s lyrics like any lyrics, before anything is spent', async () => {
    const user = await h.createUser({ credits: 3 });
    const trackId = await song(user);
    const res = await edit(user, trackId, { lyrics: '[verse]\nhttps://example.com/song.mp3 みたいな曲' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('PROMPT_BLOCKED');
  }, 60_000);

  it('has no lyrics to change on an instrumental', async () => {
    const user = await h.createUser({ credits: 3 });
    const trackId = await song(user, { instrumental: true });
    const res = await edit(user, trackId, { lyrics: '[verse]\n一句歌词' });
    expect(res.statusCode).toBe(400);
  }, 60_000);
});
