/**
 * POST /v1/lyrics/draft: lyrics written before generation, so a sung sketch
 * from Air composition arrives on /create with words to read and edit.
 *
 * No credit pays for this call, so what is pinned here is what keeps it from
 * becoming a free lyrics service: a cap per account per 24 hours that a race
 * cannot overrun, the daily spend cap, the same prompt screening generation
 * uses, every call on the cost record, and nothing of what was written kept.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '@yuha/db';
import type { LyricsResult, TextProvider } from '@yuha/providers';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ LYRIC_DRAFTS_PER_DAY: '3' });
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

const body = { prompt: '一首柔和、开阔、舒缓的歌，旋律从低处慢慢扬起，情绪平静。', styles: [], durationSeconds: 120 };
const draft = (user: TestUser | null, payload: unknown = body) =>
  h.app.inject({ method: 'POST', url: '/v1/lyrics/draft', headers: user ? user.authHeader : {}, payload: payload as never });

/** Swaps the text provider for one call's worth of a test. */
async function withText<T>(text: Partial<TextProvider>, run: () => Promise<T>): Promise<T> {
  const real = h.ctx.text;
  (h.ctx as { text: TextProvider }).text = { ...real, providerId: real.providerId, model: real.model, extractIntent: real.extractIntent.bind(real), ...text } as TextProvider;
  try {
    return await run();
  } finally {
    (h.ctx as { text: TextProvider }).text = real;
  }
}

describe('POST /v1/lyrics/draft', () => {
  it('writes sectioned lyrics and says how many drafts remain', async () => {
    const user = await h.createUser();
    const res = await draft(user);
    expect(res.statusCode).toBe(200);
    const json = res.json() as { lyrics: string; remaining: number };
    expect(json.lyrics).toMatch(/\[verse\]/);
    expect(json.remaining).toBe(2);
  });

  it('is for signed-in accounts only', async () => {
    expect((await draft(null)).statusCode).toBe(401);
  });

  it('stops at the cap for 24 hours, per account', async () => {
    const user = await h.createUser();
    for (let i = 0; i < 3; i += 1) expect((await draft(user)).statusCode).toBe(200);
    const over = await draft(user);
    expect(over.statusCode).toBe(429);
    expect(over.json().error.code).toBe('RATE_LIMITED');
    const other = await h.createUser();
    expect((await draft(other)).statusCode).toBe(200);
  });

  it('cannot be overrun by requests racing for the last draft', async () => {
    const user = await h.createUser();
    const results = await Promise.all(Array.from({ length: 8 }, () => draft(user)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(3);
    const rows = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM lyric_drafts WHERE user_id = ?`, [user.id]);
    expect(Number(rows[0]!.n)).toBe(3);
  });

  it('screens the prompt like generation does, before any paid call, and does not count it', async () => {
    const user = await h.createUser();
    let called = 0;
    await withText({ writeLyrics: async () => { called += 1; return { status: 'ok', lyrics: 'x', requestId: null, usage: { costMinor: 0, costIsEstimate: true } }; } }, async () => {
      const res = await draft(user, { ...body, prompt: 'あの歌手の声を真似して歌って' });
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('PROMPT_BLOCKED');
    });
    expect(called).toBe(0);
    expect((await draft(user)).json().remaining).toBe(2);
  });

  it('a model failure is an error, and still counts: the call was paid for', async () => {
    const user = await h.createUser();
    const failed: LyricsResult = { status: 'failed', reason: 'lyrics_truncated', requestId: 'r-1', usage: { costMinor: 3, costIsEstimate: true } };
    await withText({ writeLyrics: async () => failed }, async () => {
      const res = await draft(user);
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('UPSTREAM_UNAVAILABLE');
    });
    expect((await draft(user)).json().remaining).toBe(1);
  });

  it('records every call on the cost record, with no job, marked as a lyric draft', async () => {
    const user = await h.createUser();
    await withText(
      { writeLyrics: async () => ({ status: 'ok', lyrics: '[verse]\n月', requestId: 'r-2', usage: { costMinor: 2, costIsEstimate: true, promptTokens: 10, completionTokens: 20 } }) },
      () => draft(user),
    );
    const rows = await query<{ job_id: string | null; provider_kind: string; event_type: string; cost_minor: number; usage_data: unknown }>(
      `SELECT job_id, provider_kind, event_type, cost_minor, usage_data FROM provider_cost_events`,
    );
    expect(rows).toHaveLength(1);
    const usage = typeof rows[0]!.usage_data === 'string' ? JSON.parse(rows[0]!.usage_data) : rows[0]!.usage_data;
    expect(rows[0]).toMatchObject({ job_id: null, provider_kind: 'text', event_type: 'success', cost_minor: 2 });
    expect(usage).toMatchObject({ purpose: 'lyric_draft', requestId: 'r-2' });
  });

  it('keeps nothing of what was written or asked: the count is all it stores', async () => {
    const user = await h.createUser();
    await draft(user);
    const cols = await query<{ COLUMN_NAME: string }>(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'lyric_drafts'`,
    );
    expect(cols.map((c) => c.COLUMN_NAME).sort()).toEqual(['created_at', 'id', 'status', 'user_id']);
  });

  it('refuses a provider that cannot write lyrics, without counting', async () => {
    const user = await h.createUser();
    await withText({ writeLyrics: undefined }, async () => {
      const res = await draft(user);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe('UNSUPPORTED_CAPABILITY');
    });
    expect((await draft(user)).json().remaining).toBe(2);
  });

  it('a lyric the model writes that the screen would block is not handed over', async () => {
    const user = await h.createUser();
    await withText(
      { writeLyrics: async () => ({ status: 'ok', lyrics: '[verse]\nhttps://example.com/song.mp3 みたいな曲', requestId: null, usage: { costMinor: 1, costIsEstimate: true } }) },
      async () => {
        const res = await draft(user);
        expect(res.statusCode).toBe(422);
      },
    );
  });
});
