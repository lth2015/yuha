/**
 * What a preset looks like. The sound came first; a scene gives a preset a
 * picture of its own. Pure: positions are fractions of the stage with y going
 * up (as in a GestureFrame), so light.ts does all the drawing and these stay
 * testable (tests/air-scene.test.ts).
 *
 * The lake: a pale landscape in YUHA's own palette, light and quiet, behind
 * every preset (first drawn for 春江, then made the page's own background).
 * Distant hills in faint ink, a still lake, a sun that rises with the
 * performance, a few drifting petals (the YUHA mark). The player's notes are
 * ripples on the water and soft light in the sky.
 */
import { PRESETS } from '../engine/presets.ts';

export type SceneId = 'paper' | 'lake';

/** Every preset plays on the lake; plain paper is only the fallback for an id this page does not know. */
export function sceneFor(presetId: string): SceneId {
  return PRESETS.some((p) => p.id === presetId) ? 'lake' : 'paper';
}

/** Where the lake meets the far shore, from the bottom of the stage. */
export const HORIZON = 0.4;

/** The sun comes up from behind the hills as the performance goes on. `progress`: 0…1. */
export function sunAt(progress: number): { x: number; y: number; r: number } {
  const p = Math.min(1, Math.max(0, progress));
  // Eased so it clears the hills quickly and settles slowly, the way it looks.
  const lift = 1 - (1 - p) ** 2;
  return { x: 0.66 - 0.05 * lift, y: HORIZON + 0.07 + 0.36 * lift, r: 0.06 };
}

/**
 * Height of the hills at `x` for a layer: 0 is the farthest and tallest,
 * 2 the nearest and lowest. Fixed sums of sines, so the skyline never changes.
 */
export function ridge(layer: number, x: number): number {
  const L = [
    { base: 0.075, amp: 0.05, f: [1.3, 3.1, 7.7], ph: 0.4 },
    { base: 0.05, amp: 0.032, f: [1.9, 4.3, 9.1], ph: 2.1 },
    { base: 0.025, amp: 0.018, f: [2.6, 5.7, 12.3], ph: 4.0 },
  ][layer]!;
  const wave = Math.sin(x * L.f[0]! * Math.PI + L.ph) * 0.6 + Math.sin(x * L.f[1]! * Math.PI + L.ph * 1.7) * 0.3 + Math.sin(x * L.f[2]! * Math.PI + L.ph * 2.3) * 0.1;
  return HORIZON + 0.004 + L.base + L.amp * (wave + 1) * 0.5;
}

/** A note on the water ripples; a note in the sky is soft light. */
export function splashFor(y: number): 'ripple' | 'glow' {
  return y < HORIZON ? 'ripple' : 'glow';
}

/** Low notes warm petal, high notes cool blue-grey. Always pale. */
export function lakeTone(pitch: number): { hue: number; sat: number; light: number } {
  const k = Math.min(1, Math.max(0, (pitch - 48) / 36));
  return { hue: k < 0.5 ? 14 + k * 30 : 200 + (k - 0.5) * 20, sat: 60 - k * 12, light: 74 + k * 8 };
}
