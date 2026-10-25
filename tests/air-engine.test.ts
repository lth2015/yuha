/**
 * The air composition engine (#28): gesture frames in, musical events out.
 *
 * The promise to a person who knows no music is that nothing they do sounds
 * wrong, that up means higher and faster means busier, and that stillness is
 * calm rather than noise. Each of those is a property of the event stream, so
 * these tests assert properties over many seeded random gestures instead of
 * snapshotting notes — a snapshot would fail every time the music is tuned to
 * sound better, which is exactly the change that should be cheap.
 *
 * No database, no audio: the engine is pure.
 */
import { describe, expect, it } from 'vitest';
import { chordAt, HARMONY_FLOOR, perform, stepMs, type NoteEvent } from '../apps/air/src/engine/performer.js';
import { PRESETS, presetFor } from '../apps/air/src/engine/presets.js';
import type { GestureFrame } from '../apps/air/src/engine/frame.js';

const pc = (midi: number) => ((midi % 12) + 12) % 12;

/** Independent of the engine's own randomness, so the tests do not grade their own homework. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

const frame = (t: number, over: Partial<GestureFrame> = {}): GestureFrame => ({
  t,
  active: true,
  x: 0.5,
  y: 0.5,
  speed: 0,
  openness: 0,
  spread: null,
  confidence: 1,
  source: 'touch',
  ...over,
});

/** A finger wandering at random for `ms`, lifting and landing now and then — "随意乱动". */
function wander(seed: number, ms = 20_000, hz = 60): GestureFrame[] {
  const r = rng(seed);
  const out: GestureFrame[] = [];
  let y = r();
  let speed = r();
  let active = true;
  for (let t = 0; t <= ms; t += 1000 / hz) {
    y = Math.min(1, Math.max(0, y + (r() - 0.5) * 0.08));
    speed = Math.min(1, Math.max(0, speed + (r() - 0.5) * 0.1));
    if (r() < 0.004) active = !active;
    out.push(frame(t, { active, y, speed, x: r() }));
  }
  return out;
}

/** Holding one gesture steadily for `ms`. */
const hold = (over: Partial<GestureFrame>, ms = 16_000, hz = 60) =>
  Array.from({ length: Math.floor((ms * hz) / 1000) + 1 }, (_, i) => frame((i * 1000) / hz, over));

const lead = (events: NoteEvent[]) => events.filter((e) => e.voice === 'lead');
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1);

describe('the presets', () => {
  it('are between three and five, each with its own id', () => {
    expect(PRESETS.length).toBeGreaterThanOrEqual(3);
    expect(PRESETS.length).toBeLessThanOrEqual(5);
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
  });

  it('are chosen by the seed: the same seed always gets the same one, and every one is reachable', () => {
    for (let seed = 0; seed < 200; seed += 1) expect(presetFor(seed)).toBe(presetFor(seed));
    const reached = new Set(Array.from({ length: 200 }, (_, seed) => presetFor(seed * 2654435761).id));
    expect(reached.size).toBe(PRESETS.length);
  });

  it('give every preset a scale and chords inside one octave, and a register a phone can carry', () => {
    for (const p of PRESETS) {
      for (const n of [...p.scale, ...p.progression.flat()]) expect(n >= 0 && n < 12, `${p.id} ${n}`).toBe(true);
      expect(p.register[1] - p.register[0]).toBeGreaterThanOrEqual(24);
      expect(p.register[0]).toBeGreaterThanOrEqual(48);
      expect(p.register[1]).toBeLessThanOrEqual(88);
    }
  });
});

/* Every musical property below must hold for every preset, not just the first. */
describe.each(PRESETS)('preset $id', (preset) => {
  const pcsOf = (rel: readonly number[]) => new Set(rel.map((r) => pc(preset.root + r)));

  describe('nothing sounds wrong', () => {
    it('puts every accented note on a tone of the chord sounding at that moment', () => {
      for (const seed of SEEDS) {
        for (const e of lead(perform(preset, seed, wander(seed)))) {
          if (e.accent) expect(pcsOf(chordAt(preset, e.t)).has(pc(e.pitch)), `seed ${seed} t ${e.t}`).toBe(true);
        }
      }
    });

    it('accents every note that lands on a beat, so strong beats are always chord tones', () => {
      for (const seed of SEEDS) {
        const beat = stepMs(preset) * 4;
        for (const e of lead(perform(preset, seed, wander(seed)))) {
          if (Math.abs(e.t / beat - Math.round(e.t / beat)) < 1e-9) expect(e.accent, `seed ${seed} t ${e.t}`).toBe(true);
        }
      }
    });

    it('keeps every other note inside the scale, and every pad note inside its chord', () => {
      const scale = pcsOf(preset.scale);
      for (const seed of SEEDS) {
        for (const e of perform(preset, seed, wander(seed))) {
          if (e.voice === 'pad') expect(pcsOf(chordAt(preset, e.t)).has(pc(e.pitch))).toBe(true);
          else if (!e.accent) expect(scale.has(pc(e.pitch)), `seed ${seed} t ${e.t}`).toBe(true);
        }
      }
    });

    it('stays inside a register a phone speaker can carry', () => {
      for (const seed of SEEDS) {
        for (const e of lead(perform(preset, seed, wander(seed)))) {
          expect(e.pitch).toBeGreaterThanOrEqual(preset.register[0]);
          expect(e.pitch).toBeLessThanOrEqual(preset.register[1]);
        }
      }
    });
  });

  describe('up is higher, faster is busier', () => {
    it('plays higher and brighter when the hand is higher', () => {
      for (const seed of SEEDS.slice(0, 10)) {
        const low = lead(perform(preset, seed, hold({ y: 0.2, speed: 0.5 })));
        const high = lead(perform(preset, seed, hold({ y: 0.8, speed: 0.5 })));
        expect(mean(high.map((e) => e.pitch))).toBeGreaterThan(mean(low.map((e) => e.pitch)));
        expect(mean(high.map((e) => e.brightness))).toBeGreaterThan(mean(low.map((e) => e.brightness)));
      }
    });

    it('plays more notes when the hand moves faster', () => {
      for (const seed of SEEDS.slice(0, 10)) {
        const counts = [0.1, 0.4, 0.7, 1].map((speed) => lead(perform(preset, seed, hold({ speed }))).length);
        for (let i = 1; i < counts.length; i += 1) expect(counts[i]!).toBeGreaterThanOrEqual(counts[i - 1]!);
        expect(counts[3]!).toBeGreaterThan(counts[0]! * 2);
      }
    });

    it('keeps the tempo: speed changes how many notes fall on the grid, never where the grid is', () => {
      const step = stepMs(preset);
      for (const speed of [0, 0.5, 1]) {
        const notes = lead(perform(preset, 7, hold({ speed }))).slice(1); // [0] is the touch itself
        for (const e of notes) expect(Math.abs(e.t / step - Math.round(e.t / step))).toBeLessThan(1e-9);
      }
    });

    it('never plays more than four notes a beat', () => {
      const beat = stepMs(preset) * 4;
      const notes = lead(perform(preset, 3, hold({ speed: 1 })));
      const perBeat = new Map<number, number>();
      for (const e of notes) perBeat.set(Math.floor(e.t / beat), (perBeat.get(Math.floor(e.t / beat)) ?? 0) + 1);
      expect(Math.max(...perBeat.values())).toBeLessThanOrEqual(5); // four on the grid, plus the touch
    });
  });

  describe('quiet edges', () => {
    it('makes no sound without a touch', () => {
      expect(perform(preset, 1, [])).toEqual([]);
      expect(perform(preset, 1, hold({ active: false, speed: 1 }))).toEqual([]);
    });

    it('answers the first touch at the moment it lands, not at the next beat', () => {
      const t0 = 1234.5;
      const events = perform(preset, 1, [frame(t0 - 16, { active: false }), frame(t0), frame(t0 + 16)]);
      const first = lead(events)[0]!;
      expect(first.t).toBe(t0);
      expect(first.accent).toBe(true);
    });

    it('is calm when the finger rests: at most about one note a second', () => {
      for (const seed of SEEDS.slice(0, 10)) {
        const notes = lead(perform(preset, seed, hold({ speed: 0 }, 16_000)));
        expect(notes.length / 16).toBeLessThanOrEqual(1.1);
      }
    });

    it('starts nothing new once the finger lifts', () => {
      const lift = 3000;
      const frames = [...hold({ speed: 1 }, lift), ...hold({ active: false }, 4000).map((f) => ({ ...f, t: f.t + lift + 16 }))];
      const late = lead(perform(preset, 5, frames)).filter((e) => e.t > lift + 100);
      expect(late).toEqual([]);
    });

    it('gives the same events for the same gesture and seed', () => {
      const frames = wander(11);
      expect(perform(preset, 11, frames)).toEqual(perform(preset, 11, frames));
    });
  });

  describe('opening up and spreading out (#29)', () => {
    const harmony = (events: NoteEvent[]) => events.filter((e) => e.voice === 'harmony');
    /** How many voices start together on each lead note, on average. */
    const layers = (events: NoteEvent[]) => {
      const at = new Map<number, number>();
      for (const e of events) if (e.voice !== 'pad') at.set(e.t, (at.get(e.t) ?? 0) + 1);
      return mean([...at.values()]);
    };

    it('adds no harmony while only one finger is down', () => {
      for (const seed of SEEDS.slice(0, 10)) expect(harmony(perform(preset, seed, wander(seed)))).toEqual([]);
    });

    it('adds harmony made only of chord tones, under the melody, at most a fifth below the register', () => {
      for (const seed of SEEDS) {
        const frames = wander(seed).map((f, i) => ({ ...f, spread: Math.abs(Math.sin(i / 90)) }));
        const events = perform(preset, seed, frames);
        expect(harmony(events).length).toBeGreaterThan(0);
        for (const e of harmony(events)) {
          expect(pcsOf(chordAt(preset, e.t)).has(pc(e.pitch)), `seed ${seed} t ${e.t}`).toBe(true);
          expect(e.pitch).toBeGreaterThanOrEqual(preset.register[0] - HARMONY_FLOOR);
          const melody = lead(events).find((l) => l.t === e.t)!;
          expect(e.pitch).toBeLessThan(melody.pitch);
        }
      }
    });

    it('grows from one voice to three as the fingers spread', () => {
      for (const seed of SEEDS.slice(0, 10)) {
        const [one, two, three] = [0, 0.5, 1].map((spread) => layers(perform(preset, seed, hold({ speed: 0.6, y: 0.8, spread }))));
        expect(one).toBe(1);
        expect(two).toBeGreaterThan(one!);
        expect(three).toBeGreaterThan(two!);
        expect(three).toBeLessThanOrEqual(3);
      }
    });

    it('widens the sound field as the gesture opens', () => {
      for (const seed of SEEDS.slice(0, 10)) {
        const closed = perform(preset, seed, hold({ speed: 0.5, openness: 0.1 }));
        const open = perform(preset, seed, hold({ speed: 0.5, openness: 0.9 }));
        // Per voice: an average over all of them would let one voice carry the rest.
        for (const voice of ['lead', 'pad'] as const) {
          const w = (events: NoteEvent[]) => mean(events.filter((e) => e.voice === voice).map((e) => e.width));
          expect(w(open), voice).toBeGreaterThan(w(closed));
        }
      }
    });

    it('places harmony further apart in the stereo field when the gesture is open', () => {
      const spreadOf = (openness: number) =>
        mean(harmony(perform(preset, 2, hold({ speed: 0.6, y: 0.8, spread: 1, openness }))).map((e) => Math.abs(e.pan)));
      expect(spreadOf(0.9)).toBeGreaterThan(spreadOf(0.1));
    });

    it('keeps every pan inside the stereo field', () => {
      for (const seed of SEEDS.slice(0, 10)) {
        const frames = wander(seed).map((f, i) => ({ ...f, openness: (i % 300) / 300, spread: (i % 500) / 500 }));
        for (const e of perform(preset, seed, frames)) {
          expect(Math.abs(e.pan)).toBeLessThanOrEqual(1);
          expect(e.width).toBeGreaterThanOrEqual(0);
          expect(e.width).toBeLessThanOrEqual(1);
        }
      }
    });
  });
});
