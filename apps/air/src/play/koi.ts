/**
 * A few koi idling in the lake (scenes.ts), as pure state the canvas draws.
 *
 * Behaviour follows Wonderful World's product design (their 02 §4–§5), shared
 * as principles rather than code (docs/AIR_WONDERFUL_WORLD_SYNC.md, appendix):
 * a fixed number, never swapped while you play; a finger held on the water
 * calls them slowly near, each circling at its own distance so they never pile
 * up (their lesson: fish chasing one shared circle bunch to one side); otherwise
 * they wander from one quiet spot to another, gliding between strokes.
 * Our fish swim slower than theirs (about 0.15–0.3 body lengths a second
 * against their 0.3–1.05): this lake is a backdrop to the music, not the game.
 * tests/air-koi.test.ts pins what makes them read as calm: they stay in the
 * lake, never hurry, never turn sharply.
 *
 * Coordinates are fractions of the stage, y going up, like a GestureFrame.
 */
import { HORIZON } from './scenes.ts';

export const KOI_COUNT = 5;
/** Fractions of the stage per second. Cruising is about half of this. */
export const KOI_MAX_SPEED = 0.03;
/** Radians per second: a wide, slow turn. */
export const KOI_MAX_TURN = 0.9;
/** A body length, in fractions of the stage, for the tail-beat rate. */
export const KOI_BODY = 0.06;
/** Closer than this to another fish, it turns away. */
export const KOI_ROOM = 0.06;
/** The water they keep to: clear of the far shore and of the screen's edges. */
export const LAKE = { left: 0.05, right: 0.95, bottom: 0.05, top: HORIZON - 0.06 } as const;

export type Koi = {
  x: number;
  y: number;
  heading: number;
  speed: number;
  /** Where it is idling towards when nothing draws it. */
  goal: { x: number; y: number };
  /** Its own random stream, so a seed always gives the same pond. */
  rand: number;
  /** Tail beat, advanced by distance swum. */
  phase: number;
  /** How far from a held finger it settles, so the school rings it rather than stacks. */
  ring: number;
};

function next(rand: number): [number, number] {
  // mulberry32, the same generator the engine uses.
  let t = (rand + 0x6d2b79f5) >>> 0;
  let r = Math.imul(t ^ (t >>> 15), t | 1);
  r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
  return [((r ^ (r >>> 14)) >>> 0) / 4294967296, t];
}

function pointIn(rand: number): [{ x: number; y: number }, number] {
  const [a, r1] = next(rand);
  const [b, r2] = next(r1);
  return [{ x: LAKE.left + 0.1 + a * (LAKE.right - LAKE.left - 0.2), y: LAKE.bottom + 0.04 + b * (LAKE.top - LAKE.bottom - 0.08) }, r2];
}

export function createKoi(seed: number): Koi[] {
  let rand = seed >>> 0;
  return Array.from({ length: KOI_COUNT }, (_, i) => {
    const [at, r1] = pointIn(rand);
    const [goal, r2] = pointIn(r1);
    const [h, r3] = next(r2);
    rand = r3;
    return { ...at, heading: h * Math.PI * 2, speed: 0.01, goal, rand, phase: h * 6, ring: 0.04 + i * 0.02 };
  });
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function stepKoi(school: Koi[], dtMs: number, lure: { x: number; y: number } | null): Koi[] {
  const dt = dtMs / 1000;
  return school.map((f) => {
    let { goal, rand } = f;
    let desired: number;
    let target: number;

    if (lure) {
      const d = Math.hypot(lure.x - f.x, lure.y - f.y);
      const toward = Math.atan2(lure.y - f.y, lure.x - f.x);
      // Close to its ring it turns side-on and circles slowly instead of pressing in.
      const settle = clamp((f.ring + 0.05 - d) / 0.05, 0, 1);
      desired = toward + settle * (Math.PI / 2 + 0.35);
      target = KOI_MAX_SPEED * (1 - settle) + 0.007 * settle;
    } else {
      if (Math.hypot(goal.x - f.x, goal.y - f.y) < 0.05) [goal, rand] = pointIn(rand);
      desired = Math.atan2(goal.y - f.y, goal.x - f.x);
      // A stroke, then a glide: cruising speed swells and eases on a slow beat.
      target = 0.008 + 0.009 * (1 + Math.sin(f.phase * 0.18));
    }

    // Room of its own: another fish closer than this turns it gently away, so
    // circling at neighbouring distances never brings two onto one spot.
    let ax = 0;
    let ay = 0;
    for (const o of school) {
      if (o === f) continue;
      const d = Math.hypot(f.x - o.x, f.y - o.y);
      if (d > 0 && d < KOI_ROOM) {
        const push = (KOI_ROOM - d) / KOI_ROOM;
        ax += ((f.x - o.x) / d) * push;
        ay += ((f.y - o.y) / d) * push;
      }
    }
    const crowd = Math.min(1, Math.hypot(ax, ay));
    if (crowd > 0) {
      const away = Math.atan2(ay, ax);
      desired = Math.atan2(Math.sin(desired) * (1 - crowd) + Math.sin(away) * crowd, Math.cos(desired) * (1 - crowd) + Math.cos(away) * crowd);
    }

    // Near the bank, turn back towards open water whatever else it wanted.
    const edge = Math.min(f.x - LAKE.left, LAKE.right - f.x, f.y - LAKE.bottom, LAKE.top - f.y);
    if (edge < 0.05) {
      const home = Math.atan2((LAKE.top + LAKE.bottom) / 2 - f.y, 0.5 - f.x);
      const w = clamp(1 - edge / 0.05, 0, 1);
      desired = Math.atan2(Math.sin(desired) * (1 - w) + Math.sin(home) * w, Math.cos(desired) * (1 - w) + Math.cos(home) * w);
    }

    const turn = clamp(wrap(desired - f.heading), -KOI_MAX_TURN * dt, KOI_MAX_TURN * dt);
    const heading = wrap(f.heading + turn);
    const speed = clamp(f.speed + (target - f.speed) * Math.min(1, dt * 1.2), 0, KOI_MAX_SPEED);
    const x = clamp(f.x + Math.cos(heading) * speed * dt, LAKE.left, LAKE.right);
    const y = clamp(f.y + Math.sin(heading) * speed * dt, LAKE.bottom, LAKE.top);
    // Body wave: 3 rad/s plus 5 per body length a second of speed (Wonderful World's rate).
    return { ...f, x, y, heading, speed, goal, rand, phase: f.phase + dt * (3 + (5 * speed) / KOI_BODY) };
  });
}
