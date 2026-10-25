/**
 * One performance, from the first touch to a sketch (#30).
 *
 * A sketch records the gesture, not the sound: the frames the engine saw,
 * plus the preset and seed. Replaying it through the same engine gives the
 * same events, so what you hear back is what you played. Two rules make that
 * true, and the page relies on both:
 *
 * - The live engine is fed only what the sketch keeps: at most one frame per
 *   1/20 s, except that a touch is kept at the moment it happens (the first
 *   sound must not wait for a tick). A lift is kept at the next tick, so up
 *   to 50 ms late, and a re-touch before that tick makes it one continuous
 *   touch. That bounds a performance to 40 frames a second however frantic
 *   the tapping, which is what keeps a shared link under 4 KB (share.ts).
 * - Values are kept at the precision a link carries (share.ts `quantize`),
 *   so a friend opening the link hears what was played, too.
 * - Time starts at 0 at the first touch, in both, so the beat grid lands in
 *   the same place on replay.
 */
import type { GestureFrame } from './frame.ts';
import { quantize } from './share.ts';

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
  let source: GestureFrame['source'] = 'touch';
  const kept: GestureFrame[] = [];
  let done: SessionStatus | null = null;
  let latest = 0;

  const end = (closingT: number): SessionStatus => {
    const last = kept.at(-1)!;
    if (last.t < MIN_MS) return (done = { status: 'too-short' });
    // A replay must fall silent where the live run did.
    const frames = last.active ? [...kept, quantize({ ...last, active: false }, closingT, last, source)] : [...kept];
    return (done = { status: 'ended', sketch: { version: 1, presetId: meta.presetId, seed: meta.seed, frames } });
  };

  return {
    /** Offer every raw frame; feed the engine `frame` when one comes back. */
    push(raw: GestureFrame): SessionStatus {
      if (done) return done;
      if (start === null) {
        if (!raw.active) return { status: 'idle' };
        start = raw.t;
        source = raw.source;
      }
      // Whole milliseconds: what a link stores.
      const t = Math.round(raw.t - start);
      latest = Math.min(t, MAX_MS);
      if (t >= MAX_MS) return end(MAX_MS);
      const last = kept.at(-1);
      const touch = raw.active && !last?.active;
      const due = !last || t - last.t >= 1000 / SKETCH_HZ;
      if (!touch && !due) return { status: 'playing' };
      const frame = quantize(raw, t, last, source);
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
