/**
 * What the activation metric is allowed to call "listening".
 *
 * `preview_10s` is one of the three conditions in the day-one activation
 * query, and the player used to decide it with `audio.currentTime >= 10`
 * under a comment claiming it counted real listening. The player bar has a
 * scrubber: one drag past the ten-second mark satisfied that test without a
 * second of audio being heard. These cases pin the rule that replaced it,
 * because the easy "simplification" back to a position check looks correct
 * and silently makes the number a lie.
 */
import { describe, expect, it } from 'vitest';
import {
  HEARD_SECONDS_FOR_PREVIEW,
  MAX_TICK_SECONDS,
  creditHeard,
  hasHeardEnough,
  type Heard,
} from '../apps/web/src/lib/listening.js';

const START: Heard = { id: null, seconds: 0, last: 0 };

/**
 * Plays `seconds` of audio as the browser would: ticks of about 250ms.
 *
 * The bounds are taken before the loop on purpose. Reading `h.last` in the
 * condition looks equivalent and is not: `h` is replaced every iteration and
 * its `last` advances, so the end of the loop runs away from the counter and
 * the test never returns. Written that way first, and found by running it.
 */
function playThrough(heard: Heard, id: string, seconds: number): Heard {
  const tick = 0.25;
  const start = heard.last;
  const end = start + seconds;
  let h = heard;
  for (let t = start + tick; t <= end + 1e-9; t += tick) {
    h = creditHeard(h, id, Number(t.toFixed(3)));
  }
  return h;
}

describe('creditHeard', () => {
  it('credits audio that was actually played', () => {
    const h = playThrough(creditHeard(START, 'a', 0), 'a', 12);
    expect(h.seconds).toBeGreaterThanOrEqual(HEARD_SECONDS_FOR_PREVIEW);
    expect(hasHeardEnough(h)).toBe(true);
  });

  it('credits nothing for a drag past the mark', () => {
    // One tick, then the scrubber thrown to 2:00. The old test would have
    // fired here; nobody heard anything.
    let h = creditHeard(START, 'a', 0);
    h = creditHeard(h, 'a', 0.25);
    h = creditHeard(h, 'a', 120);
    expect(h.seconds).toBeLessThan(1);
    expect(hasHeardEnough(h)).toBe(false);
  });

  it('credits nothing for a seek backwards', () => {
    let h = playThrough(creditHeard(START, 'a', 0), 'a', 4);
    const before = h.seconds;
    h = creditHeard(h, 'a', 0);
    expect(h.seconds).toBe(before);
    expect(h.last).toBe(0);
  });

  it('does not credit a tab that was throttled and came back', () => {
    // A backgrounded tab can deliver one tick covering many seconds of
    // wall clock; the audio was not necessarily audible, and in any case the
    // jump is indistinguishable from a seek.
    let h = creditHeard(START, 'a', 0);
    h = creditHeard(h, 'a', MAX_TICK_SECONDS + 0.001);
    expect(h.seconds).toBe(0);
  });

  it('starts over when the song changes', () => {
    let h = playThrough(creditHeard(START, 'a', 0), 'a', 9);
    expect(h.seconds).toBeGreaterThan(8);
    h = creditHeard(h, 'b', 0);
    expect(h).toEqual({ id: 'b', seconds: 0, last: 0 });
    expect(hasHeardEnough(h)).toBe(false);
  });

  it('accumulates across a pause and a resume', () => {
    // Pausing does not tick, so the next tick after resuming is an ordinary
    // small delta. Six seconds, a pause, six more: that is twelve heard.
    let h = playThrough(creditHeard(START, 'a', 0), 'a', 6);
    expect(hasHeardEnough(h)).toBe(false);
    h = playThrough(h, 'a', 6);
    expect(hasHeardEnough(h)).toBe(true);
  });

  it('is not satisfied by a long song played from a late position', () => {
    // Opening a shared link that starts the playhead deep into the song must
    // not count until ten seconds have gone by from there.
    let h = creditHeard(START, 'a', 150);
    h = playThrough(h, 'a', 5);
    expect(hasHeardEnough(h)).toBe(false);
    h = playThrough(h, 'a', 6);
    expect(hasHeardEnough(h)).toBe(true);
  });
});
