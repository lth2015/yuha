/**
 * The music engine's reason, from what a failed job recorded (engineReason).
 * The page shows the exception's type and never its message.
 */
import { describe, expect, it } from 'vitest';
import { engineReason } from '@yuha/contracts';
import { HttpMusicProvider, httpMusicProviderConfig } from '@yuha/providers';

describe('the reason shown for an engine failure', () => {
  it('is the exception type the engine reported', () => {
    expect(engineReason("failed: RuntimeError('CUDA out of memory. Tried to allocate 2.00 GiB')")).toBe('RuntimeError');
    expect(engineReason('failed: torch.OutOfMemoryError: CUDA out of memory')).toBe('OutOfMemoryError');
    expect(engineReason("failed: ValueError('render near-silent: -61.2 LUFS')")).toBe('ValueError');
  });

  it('is nothing when there is no type to name', () => {
    expect(engineReason('failed')).toBeNull();
    expect(engineReason('failed: {"status":"failed"}')).toBeNull();
    expect(engineReason(null)).toBeNull();
  });
});

describe('the HTTP music adapter', () => {
  it("keeps the engine's own error text instead of just the word failed", async () => {
    const provider = new HttpMusicProvider(
      httpMusicProviderConfig.parse({
        providerId: 'test-music', baseUrl: 'https://music.example', apiKey: 'k', model: 'ace-step', contractVersion: '1',
        licenseVersion: '1', territory: 'JP', allowedUses: [], prohibitedUses: [], submitPath: '/submit', pollPath: '/status/{id}',
        requestIdField: 'id', statusField: 'status', audioUrlField: 'url',
        statusMap: { pending: ['queued'], completed: ['done'], failed: ['failed'], rejected: ['rejected'] },
        supportsInstrumentalOnly: true, supportsVocals: true, supportsCancel: false, supportsWebhook: false, supportsStatusQuery: true,
        supportedDurationsSeconds: [30, 60, 120], supportedFormats: ['mp3'], commercialDeliveryPermitted: false, maxConcurrency: 1,
        dataRegion: 'jp', costPerRequestMinor: 0, billFailedRequests: false, costIsEstimate: true, allowedAudioHosts: ['music.example'],
      }),
    );
    const real = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ id: 'r1', status: 'failed', error: "RuntimeError('CUDA out of memory')" }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch;
    try {
      const res = await provider.poll({ requestKey: 'k', providerRequestId: 'r1' });
      expect(res).toMatchObject({ status: 'failed', code: 'failed', message: "RuntimeError('CUDA out of memory')" });
    } finally {
      globalThis.fetch = real;
    }
  });
});
