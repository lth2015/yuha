/**
 * The Claude text adapter (packages/providers/src/text/anthropic.ts),
 * against the Messages API's documented reply shapes.
 *
 * What is checked is what the rest of YUHA relies on: where the request goes
 * and what it carries, and how each kind of reply becomes ok / refused /
 * failed — a refusal must not read as a breakage, and half a song must not
 * read as lyrics.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { AnthropicTextProvider } from '@yuha/providers';

interface Seen {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function server(replies: Array<{ status?: number; body: unknown }>) {
  const seen: Seen[] = [];
  let i = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({
      url: String(input instanceof Request ? input.url : input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    const r = replies[Math.min(i++, replies.length - 1)]!;
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', 'request-id': `req_${i}` },
    });
  }) as typeof globalThis.fetch;
  return { fetch, seen };
}

const message = (text: string, stop_reason = 'end_turn', extra: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: text ? [{ type: 'text', text }] : [],
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 1000, output_tokens: 2000 },
  ...extra,
});

const LYRICS = '[verse]\n雨の駅で\n傘をたたむ\n[chorus]\nまた会えるよ\nまた会えるよ';
const ask = { prompt: '雨の日の駅で別れた人', styles: ['ballad'], durationSeconds: 60 };

afterEach(() => {
  delete process.env['ANTHROPIC_BASE_URL'];
});

describe('writing lyrics', () => {
  it('sends the creator text as data to the Anthropic API, and returns the lyrics with their cost', async () => {
    // A variable meant for another tool must not redirect creators' text.
    process.env['ANTHROPIC_BASE_URL'] = 'http://elsewhere.invalid';
    const s = server([{ body: message(LYRICS) }]);
    const p = new AnthropicTextProvider({ apiKey: 'k', fetch: s.fetch });
    const res = await p.writeLyrics(ask);

    expect(res).toMatchObject({ status: 'ok', lyrics: LYRICS });
    const [req] = s.seen;
    expect(new URL(req!.url).origin).toBe('https://api.anthropic.com');
    expect(req!.headers.get('authorization')).toBe('Bearer k');
    expect(req!.body).toMatchObject({ model: 'claude-opus-5-5', fallbacks: 'default', output_config: { effort: 'medium' } });
    expect(req!.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    // The creator's words are in the user turn, never in the instructions.
    expect(String(req!.body['system'])).not.toContain('雨の日の駅');
    expect(JSON.stringify(req!.body['messages'])).toContain('雨の日の駅');
    // 1000 in × $4/M + 2000 out × $20/M = $0.044 → ¥7 at 155, rounded up; an estimate.
    expect(res.usage).toMatchObject({ promptTokens: 1000, completionTokens: 2000, costMinor: 7, costIsEstimate: true });
  });

  it('a refusal is a refusal, not a breakage', async () => {
    const s = server([{ body: message('', 'refusal', { stop_details: { type: 'refusal', category: null, explanation: 'declined' } }) }]);
    const res = await new AnthropicTextProvider({ apiKey: 'k', fetch: s.fetch }).writeLyrics(ask);
    expect(res).toMatchObject({ status: 'refused', reason: 'declined' });
  });

  it('half a song is not offered as lyrics', async () => {
    const s = server([{ body: message('[verse]\n雨の', 'max_tokens') }]);
    const res = await new AnthropicTextProvider({ apiKey: 'k', fetch: s.fetch }).writeLyrics(ask);
    expect(res).toMatchObject({ status: 'failed', reason: 'lyrics_truncated' });
  });

  it('an API error is a failure that names its status', async () => {
    const s = server([{ status: 400, body: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } } }]);
    const res = await new AnthropicTextProvider({ apiKey: 'k', fetch: s.fetch }).writeLyrics(ask);
    expect(res).toMatchObject({ status: 'failed', reason: 'anthropic_400' });
  });
});

describe('the song parameters', () => {
  const intent = {
    mode: 'simple' as const,
    scene: 'night_walk',
    prompt: '夜の海',
    energy: 0.4,
    durationSeconds: 120,
    styles: ['シティポップ'],
    instrumental: false,
    lyrics: null,
    title: null,
  };
  const reply = {
    scene: 'night_walk',
    mood: 'dreamy',
    energy: 1.7, // out of range: brought inside it
    tempoHint: 'slow',
    instruments: ['synth', 'soft_drums', 'bass', 'piano', 'strings', 'pad', 'guitar'], // one too many
    durationSeconds: 120,
    vocalMode: 'with_vocals',
    styles: ['city pop'],
    brief: 'dreamy city pop at night',
    lyrics: LYRICS,
    title: '夜の海',
  };

  it('asks for the shape through structured outputs and returns it validated', async () => {
    const s = server([{ body: message(JSON.stringify(reply)) }]);
    const res = await new AnthropicTextProvider({ apiKey: 'k', fetch: s.fetch }).extractIntent(intent);
    expect(res.status).toBe('ok');
    if (res.status !== 'ok') return;
    expect(res.intent).toMatchObject({ energy: 1, lyrics: LYRICS, durationSeconds: 120 });
    expect(res.intent.instruments).toHaveLength(6);
    const format = (s.seen[0]!.body['output_config'] as { format: { type: string; schema: { properties: Record<string, unknown> } } }).format;
    expect(format.type).toBe('json_schema');
    expect(Object.keys(format.schema.properties)).toContain('lyrics');
  });

  it('a reply outside the contract is a failure, not a song', async () => {
    const s = server([{ body: message(JSON.stringify({ ...reply, mood: 'sleepy' })) }]);
    const res = await new AnthropicTextProvider({ apiKey: 'k', fetch: s.fetch }).extractIntent(intent);
    expect(res).toMatchObject({ status: 'failed', code: 'text_schema_invalid' });
  });
});

describe('editing a song', () => {
  it('keeps what was not asked to change', async () => {
    const s = server([{ body: message(JSON.stringify({ title: null, styles: ['ballad'], lyrics: null })) }]);
    const res = await new AnthropicTextProvider({ apiKey: 'k', fetch: s.fetch }).reviseSong({
      instructions: 'make it slower',
      original: { title: '雨', styles: ['pop'], lyrics: LYRICS, instrumental: false, durationSeconds: 60 },
    });
    expect(res).toMatchObject({ status: 'ok', title: '雨', styles: ['ballad'], lyrics: LYRICS });
  });
});
