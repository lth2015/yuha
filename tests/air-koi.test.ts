/**
 * Koi in the air page's lake: a few fish idling in the water, drawn in code.
 * The behaviour follows Wonderful World's 送鱼 agreements (shared as principles,
 * not code, docs/AIR_WONDERFUL_WORLD_SYNC.md): a fixed number, never swapped
 * while you play, never summoned; a finger held on the water draws them slowly
 * near; otherwise they wander, unhurried.
 *
 * What is pinned here is what makes them read as calm and stay in the picture:
 * they never leave the lake, never hurry, never turn sharply, and gathering
 * does not pile them on top of each other. No database, no canvas: pure.
 */
import { describe, expect, it } from 'vitest';
import { HORIZON } from '../apps/air/src/play/scenes.js';
import { KOI_COUNT, KOI_MAX_SPEED, KOI_MAX_TURN, LAKE, createKoi, stepKoi, type Koi } from '../apps/air/src/play/koi.js';

const FRAME = 1000 / 60;

function run(fish: Koi[], ms: number, lure: { x: number; y: number } | null = null, each?: (prev: Koi[], next: Koi[]) => void) {
  let school = fish;
  for (let t = 0; t < ms; t += FRAME) {
    const next = stepKoi(school, FRAME, lure);
    each?.(school, next);
    school = next;
  }
  return school;
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

describe('the koi', () => {
  it('are a fixed few, the same every time for the same seed', () => {
    expect(createKoi(7)).toHaveLength(KOI_COUNT);
    expect(KOI_COUNT).toBeGreaterThanOrEqual(2);
    expect(KOI_COUNT).toBeLessThanOrEqual(5);
    expect(run(createKoi(7), 5000)).toEqual(run(createKoi(7), 5000));
  });

  it('start in the water, below the far shore', () => {
    for (const f of createKoi(3)) {
      expect(f.y).toBeLessThan(HORIZON);
      expect(f.y).toBeGreaterThanOrEqual(LAKE.bottom);
    }
  });

  it('stay in the lake for ten minutes of wandering', () => {
    run(createKoi(11), 600_000, null, (_, next) => {
      for (const f of next) {
        expect(f.x).toBeGreaterThanOrEqual(LAKE.left);
        expect(f.x).toBeLessThanOrEqual(LAKE.right);
        expect(f.y).toBeGreaterThanOrEqual(LAKE.bottom);
        expect(f.y).toBeLessThanOrEqual(LAKE.top);
      }
    });
  });

  it('never hurry and never turn sharply, even when drawn to a finger', () => {
    for (const lure of [null, { x: 0.9, y: 0.05 }]) {
      run(createKoi(5), 60_000, lure, (prev, next) => {
        next.forEach((f, i) => {
          const p = prev[i]!;
          expect(dist(f, p) / (FRAME / 1000)).toBeLessThanOrEqual(KOI_MAX_SPEED * 1.0001);
          const turn = Math.abs(Math.atan2(Math.sin(f.heading - p.heading), Math.cos(f.heading - p.heading)));
          expect(turn / (FRAME / 1000)).toBeLessThanOrEqual(KOI_MAX_TURN * 1.0001);
        });
      });
    }
  });

  it('do move: a still lake of statues is not the point', () => {
    const start = createKoi(9);
    const later = run(start, 20_000);
    start.forEach((f, i) => expect(dist(f, later[i]!)).toBeGreaterThan(0.05));
  });

  it('gather slowly round a finger held on the water, without piling up', () => {
    const lure = { x: 0.5, y: 0.15 };
    const school = run(createKoi(13), 25_000, lure);
    for (const f of school) expect(dist(f, lure)).toBeLessThan(0.16);
    for (let i = 0; i < school.length; i += 1)
      for (let j = i + 1; j < school.length; j += 1) expect(dist(school[i]!, school[j]!)).toBeGreaterThan(0.025);
  });

  it('drift off again once the finger lifts', () => {
    const lure = { x: 0.5, y: 0.15 };
    const gathered = run(createKoi(13), 25_000, lure);
    const after = run(gathered, 30_000, null);
    const spread = Math.max(...after.map((f) => dist(f, lure)));
    expect(spread).toBeGreaterThan(0.16);
  });
});
