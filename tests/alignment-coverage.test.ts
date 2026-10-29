import { afterEach, describe, expect, it, vi } from 'vitest';
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
    expect(await provider.align(request)).toMatchObject({ status: 'failed', reason: 'aligner lyrics mismatch' });
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
});
