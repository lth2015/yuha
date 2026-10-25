/**
 * How touch becomes "openness" and "spread" (#29).
 *
 * One finger cannot open a palm, so openness is defined as dwelling: it grows
 * while the finger rests and falls back while it moves. Two fingers apart
 * stand for two hands apart. These are pure, so the device and the offline
 * listening renders compute them the same way.
 */
import { describe, expect, it } from 'vitest';
import { nextOpenness, spreadFrom } from '../apps/air/src/play/gesture-math.js';

const run = (ms: number, speed: number, start = 0, active = true) => {
  let o = start;
  for (let t = 0; t < ms; t += 16) o = nextOpenness(o, 16, speed, active);
  return o;
};

describe('nextOpenness', () => {
  it('opens fully after resting about two seconds', () => {
    expect(run(1000, 0)).toBeGreaterThan(0.3);
    expect(run(1000, 0)).toBeLessThan(0.8);
    expect(run(2500, 0)).toBeGreaterThan(0.95);
  });

  it('falls back slowly while the finger moves, faster when it moves faster', () => {
    const slow = run(1000, 0.3, 1);
    const fast = run(1000, 1, 1);
    expect(slow).toBeLessThan(1);
    expect(fast).toBeLessThan(slow);
    expect(run(200, 1, 1)).toBeGreaterThan(0.6); // slowly, not at once
  });

  it('closes at once when the finger lifts', () => {
    expect(nextOpenness(0.9, 16, 0, false)).toBe(0);
  });

  it('stays between 0 and 1', () => {
    for (const speed of [0, 0.5, 1]) {
      for (const start of [0, 0.5, 1]) {
        const o = run(5000, speed, start);
        expect(o).toBeGreaterThanOrEqual(0);
        expect(o).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('spreadFrom', () => {
  it('is null with one finger and grows with the distance between two', () => {
    expect(spreadFrom(null)).toBeNull();
    const values = [0, 0.1, 0.3, 0.5, 0.7, 2].map((d) => spreadFrom(d)!);
    for (let i = 1; i < values.length; i += 1) expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
    expect(values[0]).toBe(0);
    expect(values.at(-1)).toBe(1);
  });

  it('treats fingers held together as no spread, so a two-finger touch starts as one voice', () => {
    expect(spreadFrom(0.12)).toBe(0);
  });
});
