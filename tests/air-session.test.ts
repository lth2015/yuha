/**
 * One performance: start, at most 30 seconds, a sketch, and a replay that is
 * the same music (#30).
 *
 * "Replay is exactly what I played" is a promise on screen, so it is a test:
 * the events a sketch replays to must equal, field by field, the events the
 * live performance produced. That holds only if the live engine sees exactly
 * the frames the sketch keeps — the 20 Hz downsample, with every touch and
 * lift kept at its real moment — and if time starts at 0 in both, so the
 * beat grid falls in the same place. Sample-identical audio is NOT promised:
 * Web Audio scheduling varies by device and load.
 *
 * No database, no audio: pure.
 */
import { describe, expect, it } from 'vitest';
import type { GestureFrame } from '../apps/air/src/engine/frame.js';
import { createPerformer, perform, type NoteEvent } from '../apps/air/src/engine/performer.js';
import { PRESETS } from '../apps/air/src/engine/presets.js';
import { createSession, MAX_MS, MIN_MS, SKETCH_HZ, type Sketch } from '../apps/air/src/engine/session.js';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

/** 60 Hz frames on a clock that started long before this performance, as a real page's would. */
function wander(seed: number, ms: number, offset = 98_765.4): GestureFrame[] {
  const r = rng(seed);
  const out: GestureFrame[] = [];
  let y = r();
  let speed = r();
  let active = false;
  for (let t = 0; t <= ms; t += 1000 / 60) {
    y = Math.min(1, Math.max(0, y + (r() - 0.5) * 0.08));
    speed = Math.min(1, Math.max(0, speed + (r() - 0.5) * 0.1));
    if (t > 200 && r() < 0.01) active = !active;
    if (t > 100 && t < 200) active = true;
    out.push({ t: offset + t, active, x: r(), y, speed, openness: r(), spread: r() < 0.5 ? null : r(), confidence: 1, source: 'touch' });
  }
  return out;
}

/** Run frames through a session exactly as the page does, performing live. */
function live(seed: number, frames: GestureFrame[], finishAt?: number) {
  const session = createSession({ presetId: PRESETS[0]!.id, seed });
  const performer = createPerformer(PRESETS[0]!, seed);
  const events: NoteEvent[] = [];
  const fed: GestureFrame[] = [];
  let outcome: ReturnType<typeof session.push> = { status: 'idle' };
  for (const f of frames) {
    if (finishAt !== undefined && f.t >= finishAt) {
      outcome = session.finish();
      break;
    }
    outcome = session.push(f);
    if (outcome.frame) {
      fed.push(outcome.frame);
      events.push(...performer.push(outcome.frame));
    }
    if (outcome.status === 'ended' || outcome.status === 'too-short') break;
  }
  return { events, fed, outcome };
}

describe('a performance', () => {
  it('does not start until a finger is down', () => {
    const session = createSession({ presetId: 'morning', seed: 1 });
    const idle = { t: 5, active: false, x: 0.5, y: 0.5, speed: 0, openness: 0, spread: null, confidence: 1, source: 'touch' as const };
    expect(session.push(idle)).toEqual({ status: 'idle' });
    expect(session.push({ ...idle, t: 9, active: true }).status).toBe('playing');
  });

  it('reports how far into its 30 seconds it is', () => {
    const session = createSession({ presetId: 'morning', seed: 1 });
    const f = { t: 1000, active: true, x: 0.5, y: 0.5, speed: 0, openness: 0, spread: null, confidence: 1, source: 'touch' as const };
    session.push(f);
    session.push({ ...f, t: 13_500, active: false });
    expect(session.elapsed()).toBe(12_500);
    session.push({ ...f, t: 60_000 });
    expect(session.elapsed()).toBe(MAX_MS);
  });

  it('starts its clock at the first touch, so time in the sketch begins at 0', () => {
    const { fed } = live(1, wander(1, 3000));
    expect(fed[0]!.t).toBe(0);
    expect(fed[0]!.active).toBe(true);
  });

  it('ends by itself after 30 seconds, with a sketch of at most 30 seconds', () => {
    const { outcome } = live(2, wander(2, 40_000));
    expect(outcome.status).toBe('ended');
    const sketch = (outcome as { sketch: Sketch }).sketch;
    expect(sketch.frames.at(-1)!.t).toBeLessThanOrEqual(MAX_MS);
    expect(sketch.frames.at(-1)!.t).toBeGreaterThan(MAX_MS - 1000 / SKETCH_HZ - 1);
  });

  it('closes the sketch with the finger lifted, so a replay ends in silence like the live run', () => {
    // Held down straight through the 30 seconds: the sketch must still end lifted.
    const held = wander(3, 40_000).map((f) => ({ ...f, active: f.t - 98_765.4 > 100 }));
    const { outcome } = live(3, held);
    const frames = (outcome as { sketch: Sketch }).sketch.frames;
    expect(frames.at(-2)!.active).toBe(true);
    expect(frames.at(-1)!.active).toBe(false);
  });

  it('treats finishing before 5 seconds as too short to replay', () => {
    const frames = wander(4, 10_000);
    const { outcome } = live(4, frames, frames[0]!.t + MIN_MS - 500);
    expect(outcome).toEqual({ status: 'too-short' });
  });

  it('gives a sketch when finished after 5 seconds', () => {
    const frames = wander(5, 20_000);
    const { outcome } = live(5, frames, frames[0]!.t + 12_000);
    expect(outcome.status).toBe('ended');
  });

  it('keeps one performance across lifting and touching again', () => {
    const { outcome } = live(6, wander(6, 40_000));
    const frames = (outcome as { sketch: Sketch }).sketch.frames;
    const touches = frames.filter((f, i) => f.active && !frames[i - 1]?.active).length;
    expect(touches).toBeGreaterThan(1);
  });

  it('records the preset and the seed it was played with', () => {
    const { outcome } = live(7, wander(7, 40_000));
    const sketch = (outcome as { sketch: Sketch }).sketch;
    expect(sketch).toMatchObject({ version: 1, presetId: 'morning', seed: 7 });
  });
});

describe('what the engine sees, live and in a sketch', () => {
  it('is at most 20 frames a second, except that every touch and lift is kept', () => {
    const { outcome } = live(8, wander(8, 40_000));
    const frames = (outcome as { sketch: Sketch }).sketch.frames;
    for (let i = 1; i < frames.length; i += 1) {
      const edge = frames[i]!.active !== frames[i - 1]!.active;
      if (!edge) expect(frames[i]!.t - frames[i - 1]!.t).toBeGreaterThanOrEqual(1000 / SKETCH_HZ - 1e-9);
    }
  });

  it('loses no touch: every touch in the raw input is in the sketch, at its real moment', () => {
    const raw = wander(9, 40_000);
    const { outcome } = live(9, raw);
    const sketch = (outcome as { sketch: Sketch }).sketch;
    const start = raw.find((f) => f.active)!.t;
    const rawTouches = raw.filter((f, i) => f.active && !raw[i - 1]?.active && f.t - start <= sketch.frames.at(-1)!.t).map((f) => f.t - start);
    const kept = sketch.frames.filter((f, i) => f.active && !sketch.frames[i - 1]?.active).map((f) => f.t);
    expect(kept).toEqual(rawTouches);
  });

  it('is exactly the frames the live engine was fed', () => {
    const { fed, outcome } = live(10, wander(10, 40_000));
    // The closing lift is added when the sketch is made; everything before it was fed live.
    expect((outcome as { sketch: Sketch }).sketch.frames.slice(0, fed.length)).toEqual(fed);
  });
});

describe('replay', () => {
  it('produces exactly the live events, field by field — pitch, velocity, duration, time, place', () => {
    for (const seed of [11, 12, 13, 14, 15]) {
      const { events, outcome } = live(seed, wander(seed, 40_000));
      const sketch = (outcome as { sketch: Sketch }).sketch;
      const replayed = perform(PRESETS.find((p) => p.id === sketch.presetId)!, sketch.seed, sketch.frames);
      expect(replayed).toEqual(events);
    }
  });

  it('puts every bloom where the finger was: events carry the position they were played at', () => {
    const { events } = live(16, wander(16, 10_000));
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.x).toBeGreaterThanOrEqual(0);
      expect(e.x).toBeLessThanOrEqual(1);
      expect(e.y).toBeGreaterThanOrEqual(0);
      expect(e.y).toBeLessThanOrEqual(1);
    }
  });

  it('is the same every time', () => {
    const { outcome } = live(17, wander(17, 40_000));
    const sketch = (outcome as { sketch: Sketch }).sketch;
    const preset = PRESETS[0]!;
    expect(perform(preset, sketch.seed, sketch.frames)).toEqual(perform(preset, sketch.seed, sketch.frames));
  });
});
