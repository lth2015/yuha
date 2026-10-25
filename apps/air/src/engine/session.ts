/**
 * One performance, from the first touch to a sketch (#30).
 *
 * A sketch records the gesture, not the sound: the frames the engine saw,
 * plus the preset and seed. Replaying it through the same engine gives the
 * same events, so what you hear back is what you played. Two rules make that
 * true, and the page relies on both:
 *
 * - The live engine is fed only what the sketch keeps: frames downsampled to
 *   20 a second, except that every touch and every lift is kept at the moment
 *   it happened (the first sound must not wait for a sample tick).
 * - Time starts at 0 at the first touch, in both, so the beat grid lands in
 *   the same place on replay.
 */
import type { GestureFrame } from './frame.ts';

export const SKETCH_HZ = 20;
/** The longest performance. */
export const MAX_MS = 30_000;
/** Shorter than this is not worth replaying; the player just starts again. */
export const MIN_MS = 5_000;

export type Sketch = {
  version: 1;
  presetId: string;
  seed: number;
  frames: GestureFrame[];
};

export type SessionStatus =
  | { status: 'idle'; frame?: undefined }
  | { status: 'playing'; frame?: GestureFrame }
  | { status: 'ended'; sketch: Sketch; frame?: undefined }
  | { status: 'too-short'; frame?: undefined };

export function createSession(meta: { presetId: string; seed: number }) {
  let start: number | null = null;
  let previousActive = false;
  const kept: GestureFrame[] = [];
  let done: SessionStatus | null = null;
  let latest = 0;

  const end = (closingT: number): SessionStatus => {
    const last = kept.at(-1)!;
    if (last.t < MIN_MS) return (done = { status: 'too-short' });
    // A replay must fall silent where the live run did.
    const frames = last.active ? [...kept, { ...last, t: closingT, active: false, speed: 0, openness: 0, spread: null }] : [...kept];
    return (done = { status: 'ended', sketch: { version: 1, presetId: meta.presetId, seed: meta.seed, frames } });
  };

  return {
    /** Offer every raw frame; feed the engine `frame` when one comes back. */
    push(raw: GestureFrame): SessionStatus {
      if (done) return done;
      if (start === null) {
        if (!raw.active) return { status: 'idle' };
        start = raw.t;
      }
      const t = raw.t - start;
      latest = Math.min(t, MAX_MS);
      if (t >= MAX_MS) return end(MAX_MS);
      const edge = raw.active !== previousActive;
      previousActive = raw.active;
      const last = kept.at(-1);
      if (last && !edge && t - last.t < 1000 / SKETCH_HZ) return { status: 'playing' };
      const frame = { ...raw, t };
      kept.push(frame);
      return { status: 'playing', frame };
    },
    /** Milliseconds since the first touch, up to MAX_MS: what the progress ring shows. */
    elapsed: () => latest,
    /** The player tapped "done". */
    finish(): SessionStatus {
      if (done) return done;
      if (start === null) return { status: 'idle' };
      return end(kept.at(-1)!.t);
    },
  };
}
