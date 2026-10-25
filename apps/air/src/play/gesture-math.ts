/**
 * Touch → openness and spread, kept pure so the device and the offline
 * listening renders compute them the same way.
 *
 * One finger cannot open a palm, so openness means dwelling: it rises while
 * the finger rests (fully open after about two seconds), falls back while it
 * moves, faster the faster it moves, and closes when the finger lifts. This
 * is the spec's provisional mapping, to be tuned by the usability test.
 */

/** Below this speed the finger counts as resting. */
const RESTING = 0.1;
const OPEN_MS = 2000;
/** Milliseconds to close fully at top speed. */
const CLOSE_MS = 1500;

export function nextOpenness(previous: number, dtMs: number, speed: number, active: boolean): number {
  if (!active) return 0;
  const next = speed < RESTING ? previous + dtMs / OPEN_MS : previous - (speed * dtMs) / CLOSE_MS;
  return Math.min(1, Math.max(0, next));
}

/**
 * Two fingertips side by side are already about a quarter of a phone's short
 * side apart, so that much counts as no spread: a two-finger touch starts as
 * one voice and grows as the fingers part.
 */
const TOGETHER = 0.25;
const APART = 0.75;

/** `distance` in screen short-sides between two fingers, or null with one. */
export function spreadFrom(distance: number | null): number | null {
  if (distance === null) return null;
  return Math.min(1, Math.max(0, (distance - TOGETHER) / (APART - TOGETHER)));
}
