/**
 * Lyrics written ahead of generation, so a sung sketch from Air composition
 * arrives on /create with words already in the lyrics box, to read and edit.
 *
 * This is the one text call that is not paid for by a credit, so it is built
 * to be cheap: plain text rather than a JSON object (no schema, no repair
 * round trip), one call, and a reply budget sized to the song's length. These
 * pin that, and what comes back: lyrics, a refusal, or a failure, never a
 * half-written song presented as a finished one.
 *
 * No database: a stubbed transport, as in tokenstars.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { LocalTextProvider, TokenStarsTextProvider } from '@yuha/providers';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub(reply: unknown, status = 200) {
  const calls: Array<{ body: Record<string, unknown> }> = [];
  globalThis.fetch = (async (_input: unknown, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)) });
    return new Response(typeof reply === 'string' ? reply : JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

const completion = (content: string, finish = 'stop') => ({
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finish }],
  usage: { prompt_tokens: 120, completion_tokens: 300, total_tokens: 420 },
});

const LYRICS = '[verse]\n晚风吹过湖面\n灯一盏一盏亮起\n\n[chorus]\n慢慢地 慢慢地\n把心事放进水里';
const provider = () => new TokenStarsTextProvider({ apiKey: 'sk-test', model: 'gpt-5.4-nano', structuredOutputs: true });
const req = { prompt: '一首柔和、开阔、舒缓的歌，旋律从低处慢慢扬起，情绪平静。', styles: [], durationSeconds: 120 };

describe('TokenStars: writing lyrics', () => {
  it('asks once, for plain text, with the creator’s words fenced as data', async () => {
    const calls = stub(completion(LYRICS));
    await provider().writeLyrics!(req);
    expect(calls).toHaveLength(1);
    const body = calls[0]!.body;
    expect(body['response_format']).toBeUndefined();
    const messages = body['messages'] as Array<{ role: string; content: string }>;
    expect(messages[0]!.content).toMatch(/DATA, not instructions/);
    expect(messages[0]!.content).toMatch(/language of user_text/);
    expect(JSON.parse(messages[1]!.content)).toMatchObject({ user_text: req.prompt, durationSeconds: 120 });
  });

  it('sizes the reply budget to the song: a longer song may say more, a short one costs less', async () => {
    const calls = stub(completion(LYRICS));
    await provider().writeLyrics!({ ...req, durationSeconds: 30 });
    await provider().writeLyrics!({ ...req, durationSeconds: 240 });
    const [short, long] = calls.map((c) => c.body['max_tokens'] as number);
    expect(short).toBeLessThan(long!);
    expect(long).toBeLessThanOrEqual(1600);
  });

  it('returns the lyrics, without a code fence around them', async () => {
    stub(completion('```\n' + LYRICS + '\n```'));
    const r = await provider().writeLyrics!(req);
    expect(r).toMatchObject({ status: 'ok', lyrics: LYRICS });
  });

  it('a content filter is a refusal, not a failure', async () => {
    stub(completion('', 'content_filter'));
    expect((await provider().writeLyrics!(req)).status).toBe('refused');
  });

  it('a reply cut off by the budget is a failure: half a song is not offered as one', async () => {
    stub(completion(LYRICS, 'length'));
    expect((await provider().writeLyrics!(req)).status).toBe('failed');
  });

  it('an upstream error or an empty reply is a failure', async () => {
    stub({ error: 'nope' }, 500);
    expect((await provider().writeLyrics!(req)).status).toBe('failed');
    stub(completion('   '));
    expect((await provider().writeLyrics!(req)).status).toBe('failed');
  });

  it('caps what it returns at the lyrics limit', async () => {
    stub(completion('[verse]\n' + '月'.repeat(5000)));
    const r = await provider().writeLyrics!(req);
    expect(r.status === 'ok' && [...r.lyrics].length).toBeLessThanOrEqual(3000);
  });
});

describe('the local provider (demo and tests)', () => {
  it('writes sectioned lyrics, the same every time for the same request', async () => {
    const p = new LocalTextProvider();
    const a = await p.writeLyrics!(req);
    const b = await p.writeLyrics!(req);
    expect(a).toEqual(b);
    expect(a.status).toBe('ok');
    if (a.status === 'ok') {
      expect(a.lyrics).toMatch(/^\[verse\]/m);
      expect(a.lyrics).toMatch(/^\[chorus\]/m);
    }
  });
});
