/**
 * Gesture frames in, musical events out. Pure: no DOM, no audio, no clock, no
 * Math.random. Time comes from the frames and chance from the seed, so the
 * same gesture with the same seed is the same music, live or replayed.
 *
 * How it stays musical:
 * - A sixteenth-note grid at the preset's tempo. Speed decides how many grid
 *   steps sound (from under one every two beats up to four a beat); it never
 *   moves the grid, so the tempo cannot drift.
 * - Notes on a beat, and the note answering a touch, are chord tones; the
 *   rest come from the pentatonic scale.
 * - Height picks the register and the brightness.
 * - Openness widens the field: more reverb, a richer tone, voices further
 *   apart. Spread (two fingers) adds harmony under the melody, from one
 *   voice to three, made only of chord tones.
 * - The first frame of a touch sounds at once, off the grid: a person must
 *   hear that they made the sound, and waiting for the next sixteenth would
 *   blur that.
 */
import type { GestureFrame } from './frame.ts';
import type { Preset } from './presets.ts';

export type NoteEvent = {
  /** When it starts, in the frames' milliseconds. */
  t: number;
  /** MIDI note. */
  pitch: number;
  /** 0..1 */
  velocity: number;
  /** Milliseconds. */
  duration: number;
  voice: 'lead' | 'harmony' | 'pad';
  /** 0..1, how open the tone is; follows height. */
  brightness: number;
  /** A beat, the touch itself, or harmony: always a chord tone. */
  accent: boolean;
  /** -1 (left) .. 1 (right). */
  pan: number;
  /** 0..1, how wide and rich the sound field is; follows openness. */
  width: number;
  /** Where the finger was (smoothed), 0..1 each: the light blooms here, live and on replay alike. */
  x: number;
  y: number;
};

/** How far ahead of the newest frame grid steps are decided, so audio can be scheduled exactly. */
export const LOOKAHEAD_MS = 60;
/** Smoothing time constant for height, speed, position, openness and spread. */
const SMOOTH_MS = 120;
/** Harmony voices at full spread, on top of the melody. */
const MAX_HARMONY = 2;
/** Notes per beat at rest and at full speed. */
const DENSITY = [0.4, 4] as const;
/** The order grid steps join as density rises: the beat, the off-beat, then the rest. */
const STEP_RANK = [0, 2, 1, 3] as const;

export const stepMs = (p: Preset) => 60_000 / p.bpm / 4;
const barMs = (p: Preset) => stepMs(p) * 16;

/** The chord sounding at time t (relative pitch classes). */
export function chordAt(p: Preset, t: number): readonly number[] {
  const i = Math.floor(Math.max(0, t) / (barMs(p) * p.barsPerChord)) % p.progression.length;
  return p.progression[i]!;
}

/** mulberry32: small, fast, and identical on every engine. */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** The note nearest `target` whose pitch class is in `classes` (relative to root), inside the register. */
function nearest(p: Preset, classes: readonly number[], target: number): number {
  let best = p.register[0];
  let bestDistance = Infinity;
  for (let m = p.register[0]; m <= p.register[1]; m += 1) {
    if (!classes.includes((((m - p.root) % 12) + 12) % 12)) continue;
    const d = Math.abs(m - target);
    if (d < bestDistance) [best, bestDistance] = [m, d];
  }
  return best;
}

export type Performer = { push(frame: GestureFrame): NoteEvent[] };

export function createPerformer(p: Preset, seed: number): Performer {
  const random = seeded(seed);
  const step = stepMs(p);
  const chordLength = barMs(p) * p.barsPerChord;
  let last: GestureFrame | null = null;
  let y = 0;
  let speed = 0;
  let x = 0.5;
  let openness = 0;
  /** null while one finger is down. */
  let spread: number | null = null;
  /** Index of the next grid step not yet decided. */
  let nextStep = 0;
  let padUntil = -Infinity;

  /** `jitter` is drawn by the caller every step, sounding or not, so the random sequence never depends on density. */
  const lead = (t: number, accent: boolean, jitter: number): NoteEvent => {
    const [lo, hi] = p.register;
    // A little chance in the target keeps a held hand from repeating one note.
    const target = lo + y * (hi - lo) + (jitter - 0.5) * 3;
    const classes = accent ? chordAt(p, t) : p.scale;
    const density = DENSITY[0] + speed * (DENSITY[1] - DENSITY[0]);
    return {
      t,
      pitch: nearest(p, classes, target),
      velocity: clamp01(0.45 + 0.3 * speed + (accent ? 0.15 : 0)),
      duration: (step * 4 * 1.5) / Math.max(1, density),
      voice: 'lead',
      brightness: clamp01(0.15 + 0.85 * y),
      accent,
      // The melody follows the finger across the field, more so when open.
      pan: (x - 0.5) * 2 * (0.25 + 0.5 * openness),
      width: clamp01(openness),
      x: clamp01(x),
      y: clamp01(y),
    };
  };

  /** Chord tones stacked under the melody: none with one finger, up to two at full spread. */
  const harmony = (melody: NoteEvent): NoteEvent[] => {
    if (spread === null) return [];
    const count = Math.round(spread * MAX_HARMONY);
    const chord = chordAt(p, melody.t);
    const out: NoteEvent[] = [];
    let below = melody.pitch;
    for (let i = 1; i <= count; i += 1) {
      let pitch = below - 1;
      while (pitch >= p.register[0] && !chord.includes((((pitch - p.root) % 12) + 12) % 12)) pitch -= 1;
      if (pitch < p.register[0]) break;
      below = pitch;
      // Alternate sides, further apart the more open the gesture is.
      const side = i % 2 === 1 ? -1 : 1;
      out.push({ ...melody, pitch, voice: 'harmony', accent: true, velocity: melody.velocity * 0.6, pan: Math.max(-1, Math.min(1, melody.pan + side * (0.2 + 0.6 * openness))) });
    }
    return out;
  };

  /** The chord under the melody, once per chord while a finger is down. */
  const pad = (t: number): NoteEvent[] => {
    const start = Math.floor(t / chordLength) * chordLength;
    if (start < padUntil) return [];
    padUntil = start + chordLength;
    const chord = chordAt(p, t);
    return chord.map((rel, i) => ({
      t,
      pitch: nearest(p, [rel], p.root - 12 + (i * 12) / chord.length),
      velocity: 0.35,
      duration: padUntil - t,
      voice: 'pad' as const,
      brightness: clamp01(0.1 + 0.5 * y),
      accent: false,
      pan: chord.length > 1 ? ((i / (chord.length - 1)) * 2 - 1) * 0.85 * openness : 0,
      width: clamp01(openness),
      x: clamp01(x),
      y: clamp01(y),
    }));
  };

  return {
    push(frame) {
      const events: NoteEvent[] = [];
      if (!last) {
        y = frame.y;
        speed = frame.speed;
        x = frame.x;
        openness = frame.openness;
        nextStep = Math.ceil(frame.t / step);
      } else {
        const k = 1 - Math.exp(-Math.max(0, frame.t - last.t) / SMOOTH_MS);
        y += (frame.y - y) * k;
        speed += (frame.speed - speed) * k;
        x += (frame.x - x) * k;
        openness += (frame.openness - openness) * k;
      }
      // A second finger arriving starts from where it is, not from zero.
      spread = frame.spread === null ? null : spread === null ? frame.spread : spread + (frame.spread - spread) * (1 - Math.exp(-Math.max(0, frame.t - (last?.t ?? frame.t)) / SMOOTH_MS));
      const wasActive = last?.active ?? false;
      last = frame;
      if (!frame.active) {
        // Steps keep their numbering while silent, so the grid never shifts.
        nextStep = Math.max(nextStep, Math.ceil(frame.t / step));
        return events;
      }
      if (!wasActive) {
        const touch = lead(frame.t, true, random());
        events.push(...pad(frame.t), touch, ...harmony(touch));
        // The touch itself counts for the step it lands on.
        nextStep = Math.max(nextStep, Math.floor(frame.t / step) + 1);
      }
      for (; nextStep * step <= frame.t + LOOKAHEAD_MS; nextStep += 1) {
        const t = nextStep * step;
        const rank = STEP_RANK[nextStep % 4]!;
        const density = DENSITY[0] + speed * (DENSITY[1] - DENSITY[0]);
        // The same draws every step whether or not it sounds, so (for the
        // same touches) a busier gesture plays a superset of a calmer one's
        // steps. At rest even the beat sounds only part of the time.
        const roll = random();
        const jitter = random();
        const share = density - rank;
        events.push(...pad(t));
        if (roll < share) {
          const note = lead(t, rank === 0, jitter);
          events.push(note, ...harmony(note));
        }
      }
      return events;
    },
  };
}

/** Every event for a whole gesture. */
export function perform(p: Preset, seed: number, frames: readonly GestureFrame[]): NoteEvent[] {
  const performer = createPerformer(p, seed);
  return frames.flatMap((f) => performer.push(f));
}
