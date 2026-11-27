/**
 * Who is on the strict lyric timing rule (LYRIC_STRICT_TIMELINE), and what a
 * song nothing has tried to sync says about itself.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHarness, resetData, teardown, type Harness } from './helpers/harness.js';
import { lyricSyncStateOf } from '../apps/api/src/services/lyric-sync-state.js';

let staffOnly: Harness;
beforeAll(async () => {
  staffOnly = await createHarness({ LYRIC_STRICT_TIMELINE: 'staff' });
  await resetData();
});
afterAll(async () => {
  await staffOnly?.close();
  await teardown();
});

const strictFor = async (h: Harness, headers: Record<string, string> = {}) =>
  (await h.app.inject({ method: 'GET', url: '/v1/runtime', headers })).json().features.lyricStrictTimeline;

describe('the strict timing rule', () => {
  it('is on for staff only while it is staff-only, and for nobody signed out', async () => {
    const customer = await staffOnly.createUser({ credits: 0 });
    const support = await staffOnly.createUser({ credits: 0, role: 'support' });
    expect(await strictFor(staffOnly)).toBe(false);
    expect(await strictFor(staffOnly, customer.authHeader)).toBe(false);
    expect(await strictFor(staffOnly, support.authHeader)).toBe(true);
  });
});

describe('a song’s sync state', () => {
  const sung = { vocal_mode: 'with_vocals', lyrics: '[Verse]\nla la' };
  const estimate = { source: 'estimated' as const, aligner: 'estimated-v1', lines: [] };
  it('promises nothing when nothing tried, and says it could not only when an attempt ended', () => {
    expect(lyricSyncStateOf({ ...sung, lyric_timings: estimate }, null)).toBe('idle');
    expect(lyricSyncStateOf({ ...sung, lyric_timings: null }, 'kept')).toBe('idle');
    expect(lyricSyncStateOf({ ...sung, lyric_timings: estimate }, 'failed')).toBe('unavailable');
    expect(lyricSyncStateOf({ ...sung, lyric_timings: null }, 'queued')).toBe('syncing');
  });
});
