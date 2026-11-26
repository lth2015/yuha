/**
 * Watching the video service's health (the SRE checklist: probe every
 * minute; alert when unreachable five minutes running, or more than fifteen
 * queued). The rule is a pure function, so it is tested without a clock or a
 * network: one alert per streak, and a line when it recovers.
 */
import { describe, expect, it } from 'vitest';
import { nextHealthState, type HealthState } from '@yuha/worker/scene-mv';

const MIN = 60_000;
function run(samples: { ok: boolean; queued?: number | null }[]) {
  let state: HealthState = { downSince: null, alerted: false, crowded: false };
  const said: string[] = [];
  samples.forEach((s, i) => {
    const r = nextHealthState(state, { at: i * MIN, ok: s.ok, queued: s.queued ?? null });
    state = r.state;
    said.push(...r.events);
  });
  return said;
}

describe('the video service’s health', () => {
  it('raises one alert after five minutes unreachable, not one per probe, and says when it is back', () => {
    const down = Array.from({ length: 9 }, () => ({ ok: false }));
    expect(run([{ ok: true }, ...down, { ok: true }])).toEqual(['unreachable_5m', 'recovered']);
  });

  it('stays quiet for a blip shorter than five minutes', () => {
    expect(run([{ ok: false }, { ok: false }, { ok: false }, { ok: true }])).toEqual([]);
  });

  it('says once when the queue passes fifteen, and once when it is back under', () => {
    expect(run([{ ok: true, queued: 10 }, { ok: true, queued: 16 }, { ok: true, queued: 18 }, { ok: true, queued: 3 }])).toEqual([
      'queue_over_15',
      'queue_normal',
    ]);
  });
});
