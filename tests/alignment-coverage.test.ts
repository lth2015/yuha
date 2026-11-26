import { afterEach, describe, expect, it, vi } from 'vitest';
import { markCorrected } from '@yuha/contracts';
import { HttpAlignmentProvider } from '@yuha/providers';

const provider = new HttpAlignmentProvider({
  providerId: 'test-aligner', baseUrl: 'https://aligner.invalid', apiKey: 'test-only', submitPath: '/align',
  linesField: 'lines', lineTextField: 'text', lineStartField: 'start', lineEndField: 'end',
  audioUrlResolver: () => 'https://audio.invalid/test.mp3',
});
const request = { lyrics: '[verse]\n晚风吹过\n（别走）\n等你回来', durationSeconds: 30, providerRequestId: 'test-song' };
const complete = [
  { text: '晚风吹过', start: 2, end: 5 },
  { text: '（别走）', start: 6, end: 7 },
  { text: '等你回来', start: 8, end: 12 },
];

afterEach(() => vi.unstubAllGlobals());

describe('HTTP alignment coverage', () => {
  it('refuses a successful response that silently omitted original lyrics', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ lines: [complete[0], complete[2]] }));
    expect(await provider.align(request)).toMatchObject({ status: 'failed', reason: 'aligner_lyrics_mismatch' });
  });

  it('keeps complete alignment times, including backing vocals', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ lines: complete }));
    const result = await provider.align(request);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.timings.source).toBe('aligned');
      expect(result.timings.lines.map(({ text, start, end }) => ({ text, start, end }))).toEqual(complete);
    }
  });

  it.each([
    [complete[0], { ...complete[1], text: '别离开' }, complete[2]],
    [complete[2], complete[1], complete[0]],
  ])('refuses replaced or reordered words even with the same line count', async (...lines) => {
    vi.stubGlobal('fetch', async () => Response.json({ lines }));
    expect(await provider.align(request)).toMatchObject({ status: 'failed' });
  });

  /*
   * The DGX's forced aligner says, per line, how much of it it heard
   * (forced.py build_result). An unsung line is still forced somewhere, so
   * the song-level pass hides it; the line's own figure is the signal.
   */
  it('keeps how much of each line the aligner heard, and only a figure that is one', async () => {
    const withConfidence = new HttpAlignmentProvider({
      providerId: 'test-aligner', baseUrl: 'https://aligner.invalid', apiKey: 'test-only', submitPath: '/align',
      linesField: 'lines', lineTextField: 'text', lineStartField: 'start', lineEndField: 'end',
      lineConfidenceField: 'confidence',
      audioUrlResolver: () => 'https://audio.invalid/test.mp3',
    });
    vi.stubGlobal('fetch', async () =>
      Response.json({ lines: [{ ...complete[0], confidence: 1 }, { ...complete[1], confidence: 'high' }, { ...complete[2], confidence: 0.25 }] }),
    );
    const result = await withConfidence.align(request);
    expect(result.status).toBe('ok');
    if (result.status === 'ok') expect(result.timings.lines.map((l) => l.confidence)).toEqual([1, undefined, 0.25]);

    vi.stubGlobal('fetch', async () => Response.json({ lines: complete.map((l) => ({ ...l, confidence: 1.5 })) }));
    const out = await withConfidence.align(request);
    if (out.status === 'ok') expect(out.timings.lines.every((l) => l.confidence === undefined)).toBe(true);
  });

  it('a person’s correction carries no model confidence', () => {
    const t = markCorrected({ source: 'aligned', aligner: 'mms-fa', lines: [{ ...complete[0], section: '', confidence: 0.2 }] });
    expect(t.lines[0]).not.toHaveProperty('confidence');
  });

  /*
   * The DGX answers 422 with what it heard when too little of the lyrics was
   * recognised. The adapter kept only the status, so "heard 40%" and "heard
   * 84%" read the same in a log — and one of those is a threshold question.
   */
  it('keeps what the aligner said about a refusal', async () => {
    vi.stubGlobal('fetch', async () => Response.json({ error: 'low_coverage', coverage: 0.6213 }, { status: 422 }));
    expect(await provider.align(request)).toMatchObject({
      status: 'failed',
      reason: 'aligner_http_422 low_coverage coverage=0.62',
    });
  });

  it('names a timeout as a timeout', async () => {
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
    });
    expect(await provider.align(request)).toMatchObject({ status: 'failed', reason: 'aligner_timeout' });
  });

  it('sends the song itself when it is given one, instead of a link to the render', async () => {
    let sent: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return Response.json({ lines: complete });
    });
    const audio = Buffer.from('ID3 pretend song');
    const result = await new HttpAlignmentProvider({
      providerId: 'test-aligner', baseUrl: 'https://aligner.invalid', apiKey: 'test-only', submitPath: '/align',
      linesField: 'lines', lineTextField: 'text', lineStartField: 'start', lineEndField: 'end',
      // A render the aligner no longer has: no link to give.
      audioUrlResolver: () => null,
    }).align({ ...request, audio });
    expect(result.status).toBe('ok');
    expect(sent.audio_b64).toBe(audio.toString('base64'));
    expect(sent).not.toHaveProperty('audio_url');
  });
});
