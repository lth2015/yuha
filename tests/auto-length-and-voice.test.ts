/**
 * Two choices the creator used to be unable to make.
 *
 * **Length.** The form asked for one before a line was written. "Is this a
 * 2:00 song or a 3:00 song" is a question about an arrangement that does not
 * exist yet, and getting it wrong means the model either races the words or
 * pads around them. `auto` reads the length off the lyrics instead, using the
 * same per-line budget the intent prompt uses to write them, so a song written
 * to fit and a song measured to fit agree.
 *
 * **Voice.** Nothing let a creator ask for a duet, although the music service
 * has always known how to make one — it reads the voice out of the production
 * brief with a word-boundary regex. So the choice is carried as a word in that
 * brief, and the service needs no redeploy to honour it. These tests pin that
 * the word is actually there, because an option that silently does nothing is
 * the failure this repository keeps finding.
 *
 * No database: a pure function and one adapter against a stubbed transport.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SONG_DURATIONS, fitDurationToLyrics, type MusicIntent } from '@yuha/contracts';
import { HttpMusicProvider, httpMusicProviderConfig } from '@yuha/providers';

const SECONDS_PER_LINE = 6;

describe('a length taken from the lyrics', () => {
  const fit = (lyrics: string) => fitDurationToLyrics(lyrics, SECONDS_PER_LINE, SONG_DURATIONS);
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line number ${i}`).join('\n');

  it('falls back to two minutes when there are no lyrics to measure', () => {
    // The instrumental and simple paths send none, and guessing long would
    // spend the creator's generation on silence.
    expect(fit('')).toBe(120);
    expect(fit('[verse]\n[chorus]')).toBe(120);
  });

  it('grows with the words', () => {
    const short = fit(lines(2));
    const long = fit(lines(30));
    expect(short).toBeLessThan(long);
    expect(SONG_DURATIONS).toContain(short);
    expect(SONG_DURATIONS).toContain(long);
  });

  it('never picks a length the words do not fit in', () => {
    for (const n of [1, 4, 8, 12, 20, 30, 40]) {
      const picked = fit(lines(n));
      const needed = n * SECONDS_PER_LINE;
      // The longest offered length is the ceiling: a song cut short is worse
      // than one with room, and there is nothing longer to offer.
      if (picked !== Math.max(...SONG_DURATIONS)) {
        expect(picked, `${n} lines`).toBeGreaterThanOrEqual(needed);
      }
    }
  });

  it('counts a section marker as time, not as a line to sing', () => {
    const plain = lines(8);
    const sectioned = ['[verse]', lines(4), '[chorus]', lines(4)].join('\n');
    // Same eight sung lines, plus two interludes: never shorter.
    expect(fit(sectioned)).toBeGreaterThanOrEqual(fit(plain));
  });

  it('honours a provider that offers fewer lengths', () => {
    expect(fitDurationToLyrics(lines(40), SECONDS_PER_LINE, [30, 60])).toBe(60);
  });
});

describe('the voice the creator asked for', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function stub() {
    const calls: Array<Record<string, unknown>> = [];
    globalThis.fetch = (async (_input: unknown, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ id: 'req-1', status: 'queued' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return calls;
  }

  const intent = (over: Partial<MusicIntent> = {}): MusicIntent => ({
    scene: 'night_walk',
    mood: 'calm',
    energy: 0.5,
    tempoHint: 'medium',
    instruments: ['piano'],
    durationSeconds: 120,
    vocalMode: 'with_vocals',
    voice: 'auto',
    styles: ['ballad'],
    brief: 'a calm ballad, piano, 120s',
    lyrics: '[verse]\nline one',
    title: null,
    ...over,
  });

  const provider = () =>
    new HttpMusicProvider(
      httpMusicProviderConfig.parse({
        providerId: 'test-music',
        baseUrl: 'https://music.example',
        apiKey: 'k',
        model: 'ace-step',
        contractVersion: '1',
        licenseVersion: '1',
        territory: 'JP',
        allowedUses: [],
        prohibitedUses: [],
        submitPath: '/submit',
        pollPath: '/status/{id}',
        requestIdField: 'id',
        statusField: 'status',
        audioUrlField: 'url',
        statusMap: { pending: ['queued'], completed: ['done'], failed: ['failed'], rejected: ['rejected'] },
        supportsInstrumentalOnly: true,
        supportsVocals: true,
        supportsCancel: false,
        supportsWebhook: false,
        supportsStatusQuery: true,
        supportedDurationsSeconds: [30, 60, 120, 180, 240],
        supportedFormats: ['mp3'],
        commercialDeliveryPermitted: false,
        maxConcurrency: 1,
        dataRegion: 'jp',
        costPerRequestMinor: 0,
        billFailedRequests: false,
        costIsEstimate: true,
        allowedAudioHosts: ['music.example'],
      }),
    );

  const submit = async (over: Partial<MusicIntent>) => {
    const calls = stub();
    await provider().submit({ intent: intent(over), requestKey: 'k-1', format: 'mp3' });
    return String(calls[0]!['prompt']);
  };

  it('says "duet" in the brief, which is where the service looks for it', async () => {
    expect(await submit({ voice: 'duet' })).toContain('duet');
  });

  it('names female and male vocals without one matching the other', async () => {
    const female = await submit({ voice: 'female' });
    const male = await submit({ voice: 'male' });
    expect(female).toContain('female vocals');
    expect(male).toContain('male vocals');
    // `\bmale\b` must not fire inside "female" — the service's own regexes
    // depend on that, and so does this.
    expect(/\bmale\b/.test(female)).toBe(false);
  });

  it('adds nothing when the creator did not choose', async () => {
    const brief = await submit({ voice: 'auto' });
    expect(brief).toBe('a calm ballad, piano, 120s');
  });

  it('adds nothing to an instrumental, where there is nobody to sing', async () => {
    const brief = await submit({ voice: 'duet', vocalMode: 'instrumental', lyrics: null });
    expect(brief).toBe('a calm ballad, piano, 120s');
  });

  it('does not repeat a voice the brief already names', async () => {
    const brief = await submit({ voice: 'choir', brief: 'a choir in a stone room' });
    expect(brief).toBe('a choir in a stone room');
  });
});
