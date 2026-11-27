/**
 * The DGX's render report reaches YUHA (docs/BGM_STUDIO_PLAN.md, B2):
 * which model made the take, how long it rendered, whether it clipped and,
 * for an instrumental, how much voice the separator heard in it.
 *
 * Read only from a field the configuration names, like every other field of
 * the HTTP adapter. A report that is missing, malformed or partly wrong never
 * stops a delivery: what cannot be read is null, which means "not measured",
 * never "measured and fine".
 */
import { describe, expect, it } from 'vitest';
import { HttpMusicProvider, httpMusicProviderConfig } from '@yuha/providers';

const base = {
  providerId: 'test-music', baseUrl: 'https://music.example', apiKey: 'k', model: 'ace-step', contractVersion: '1',
  licenseVersion: '1', territory: 'JP', allowedUses: [], prohibitedUses: [], submitPath: '/submit', pollPath: '/status/{id}',
  requestIdField: 'id', statusField: 'status', audioUrlField: 'audio_url',
  statusMap: { pending: ['queued'], completed: ['succeeded'], failed: ['failed'], rejected: ['rejected'] },
  supportsInstrumentalOnly: true, supportsVocals: true, supportsCancel: false, supportsWebhook: false, supportsStatusQuery: true,
  supportedDurationsSeconds: [30, 60, 120], supportedFormats: ['mp3'], commercialDeliveryPermitted: false, maxConcurrency: 1,
  dataRegion: 'jp', costPerRequestMinor: 0, billFailedRequests: false, costIsEstimate: true, allowedAudioHosts: ['music.example'],
};

async function pollWith(body: unknown, cfg: Record<string, unknown> = { reportField: 'report' }) {
  const provider = new HttpMusicProvider(httpMusicProviderConfig.parse({ ...base, ...cfg }));
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    return await provider.poll({ requestKey: 'k', providerRequestId: 'r1' });
  } finally {
    globalThis.fetch = real;
  }
}

const done = (report: unknown) => ({ id: 'r1', status: 'succeeded', audio_url: 'https://music.example/a.mp3', report });

describe('the render report', () => {
  it('is read from the configured field into the delivered audio', async () => {
    const res = await pollWith(
      done({ engine: 'v15', model: 'ace-step-1.5:xl', render_seconds: 41.2, peak_dbfs: -0.4, clipped_ratio: 0.0021, vocal_ratio: 0.18, vocal_seconds: 6.5 }),
    );
    expect(res).toMatchObject({
      status: 'completed',
      audio: {
        report: { engine: 'v15', model: 'ace-step-1.5:xl', renderSeconds: 41.2, peakDbfs: -0.4, clippedRatio: 0.0021, vocalRatio: 0.18, vocalSeconds: 6.5 },
      },
    });
  });

  it('keeps "not measured" as null, never as zero', async () => {
    const res = await pollWith(done({ engine: 'v1', model: 'ace-step-v1-3.5b', render_seconds: 30, peak_dbfs: -3, clipped_ratio: 0, vocal_ratio: null, vocal_seconds: null }));
    expect(res.status === 'completed' && res.audio.report).toMatchObject({ clippedRatio: 0, vocalRatio: null, vocalSeconds: null });
  });

  it('drops a malformed value and keeps the rest; the song is delivered either way', async () => {
    const res = await pollWith(done({ engine: 'v1', model: 42, render_seconds: 'slow', clipped_ratio: 7, vocal_ratio: -1, error: "ValueError('x')" }));
    expect(res.status).toBe('completed');
    expect(res.status === 'completed' && res.audio.report).toEqual({
      engine: 'v1', model: null, renderSeconds: null, peakDbfs: null, clippedRatio: null, vocalRatio: null, vocalSeconds: null, error: "ValueError('x')",
    });
  });

  it('is absent when the service sends none, or the configuration names no field', async () => {
    const none = await pollWith({ id: 'r1', status: 'succeeded', audio_url: 'https://music.example/a.mp3' });
    expect(none.status === 'completed' && none.audio.report).toBeUndefined();
    const unnamed = await pollWith(done({ engine: 'v1' }), {});
    expect(unnamed.status === 'completed' && unnamed.audio.report).toBeUndefined();
  });
});
