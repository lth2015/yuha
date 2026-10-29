import { describe, expect, it } from 'vitest';
import { FallbackAlignmentProvider, type AlignmentProvider } from '@yuha/providers';

const request = {
  lyrics: '[Verse]\nThe words remain visible',
  durationSeconds: 30,
  providerRequestId: 'job-1',
};

describe('FallbackAlignmentProvider', () => {
  it('persists an honestly labelled estimated timeline when forced alignment fails', async () => {
    const primary: AlignmentProvider = {
      kind: 'whisper',
      align: async () => ({ status: 'failed', reason: 'aligner_http_422' }),
    };
    const fallback: AlignmentProvider = {
      kind: 'estimated-v1',
      align: async () => ({
        status: 'ok',
        timings: {
          source: 'estimated', aligner: 'estimated-v1',
          lines: [{ text: 'The words remain visible', section: 'Verse', start: 2, end: 28 }],
        },
      }),
    };

    const result = await new FallbackAlignmentProvider(primary, fallback).align(request);
    expect(result).toMatchObject({ status: 'ok', timings: { source: 'estimated', aligner: 'estimated-v1' } });
    /*
     * And says why. The reason was dropped here, and the worker logs only a
     * result that is not ok — so a song shown as 「估算同步」 left no trace of
     * whether the aligner timed out, heard too little, or was down.
     */
    expect(result).toMatchObject({ fallbackReason: 'aligner_http_422' });
  });

  it('preserves real alignment rather than overwriting it with an estimate', async () => {
    const primary: AlignmentProvider = {
      kind: 'whisper',
      align: async () => ({
        status: 'ok',
        timings: {
          source: 'aligned', aligner: 'whisper',
          lines: [{ text: 'The words remain visible', section: 'Verse', start: 3, end: 27 }],
        },
      }),
    };
    const fallback: AlignmentProvider = {
      kind: 'estimated-v1',
      align: async () => ({ status: 'failed', reason: 'should_not_run' }),
    };

    const result = await new FallbackAlignmentProvider(primary, fallback).align(request);
    expect(result).toMatchObject({ status: 'ok', timings: { source: 'aligned', aligner: 'whisper' } });
  });

  it('uses the estimate when the primary adapter throws', async () => {
    const primary: AlignmentProvider = {
      kind: 'whisper',
      align: async () => { throw new Error('connection reset'); },
    };
    const fallback: AlignmentProvider = {
      kind: 'estimated-v1',
      align: async () => ({
        status: 'ok',
        timings: { source: 'estimated', aligner: 'estimated-v1', lines: [] },
      }),
    };

    await expect(new FallbackAlignmentProvider(primary, fallback).align(request)).resolves.toMatchObject({
      status: 'ok', timings: { source: 'estimated' }, fallbackReason: 'aligner_threw: connection reset',
    });
  });
});
