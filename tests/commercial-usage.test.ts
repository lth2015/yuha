/**
 * What a song's usage record says once commercial delivery is switched on.
 *
 * The self-hosted provider (the http adapter, which is how ACE-Step on the
 * DGX is reached) was built with `allowedUses: []` and `prohibitedUses: []`.
 * While MUSIC_COMMERCIAL_DELIVERY was off nobody saw it — delivery writes a
 * "preview only" line instead. Switching it on would have printed an empty
 * licence on every paid song. The record has to say what the Terms say.
 */
import { describe, expect, it } from 'vitest';
import { createContext, loadConfig } from '@yuha/api';

const httpMusic = {
  DATABASE_URL: 'mysql://u:p@localhost:3306/x',
  RUN_MODE: 'integration',
  DEV_AUTH_SECRET: 'x',
  STORAGE_SIGNING_SECRET: 'y',
  MUSIC_ADAPTER: 'http',
  MUSIC_PROVIDER_ID: 'ace-step-spark',
  MUSIC_BASE_URL: 'https://music.example.test',
  MUSIC_API_KEY: 'k',
  MUSIC_MODEL: 'ace-step',
  MUSIC_CONTRACT_VERSION: 'c1',
  MUSIC_LICENSE_VERSION: 'l1',
  MUSIC_SUBMIT_PATH: '/submit',
  MUSIC_POLL_PATH: '/poll/{id}',
  MUSIC_REQUEST_ID_FIELD: 'id',
  MUSIC_STATUS_FIELD: 'status',
  MUSIC_AUDIO_URL_FIELD: 'audio',
  MUSIC_STATUS_MAP: '{"pending":["p"],"completed":["c"],"failed":["f"],"rejected":["r"]}',
  MUSIC_ALLOWED_AUDIO_HOSTS: 'music.example.test',
};

describe('the usage record of a self-hosted provider', () => {
  it('states the uses the Terms allow and forbid, so a paid song never carries an empty licence', () => {
    const cfg = loadConfig({ ...httpMusic, MUSIC_COMMERCIAL_DELIVERY: 'true' } as never);
    const caps = createContext(cfg).music.capabilities();

    expect(caps.commercialDeliveryPermitted).toBe(true);
    expect(caps.allowedUses.length).toBeGreaterThan(0);
    expect(caps.prohibitedUses.length).toBeGreaterThan(0);
    // Terms §4, in substance: creator content including monetised posts is
    // allowed; reselling the audio, passing it off as human, and training
    // competing models are not.
    expect(caps.allowedUses.join(' ')).toMatch(/monetised/i);
    expect(caps.prohibitedUses.join(' ')).toMatch(/resell/i);
    expect(caps.prohibitedUses.join(' ')).toMatch(/human/i);
    expect(caps.prohibitedUses.join(' ')).toMatch(/train/i);
  });
});
