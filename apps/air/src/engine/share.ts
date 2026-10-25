/**
 * A sketch as a link (#31): the gesture packed into the URL's #fragment, which
 * a browser never sends to a server, so sharing goes through no server at all.
 *
 * Size: the whole URL stays within 4,096 bytes for the worst 30 seconds,
 * because the session already keeps at most one frame per 1/20 s plus touches
 * (session.ts), and every value is stored at the precision the session gave
 * the engine — which is why a friend hears exactly what was played.
 *
 *   header  version 4 · preset 4 · source 2 · seed 32 · frame count 11
 *   frame   active 1 · Δt 7 (or 127 then 15)
 *           if active: x 5 · y 5 · speed 4 · openness 4 · has-spread 1 · spread 4
 *
 * A lifted frame stores only its time; its position is the previous frame's.
 * Decoding refuses an oversized token before reading it, and anything that
 * does not describe a sane performance (starting with a touch, ending lifted,
 * time never going backwards, at most 30 s, no trailing bytes) is no sketch.
 */
import type { GestureFrame } from './frame.ts';
import { PRESETS } from './presets.ts';
import type { Sketch } from './session.ts';

const VERSION = 1;
/** A token longer than this cannot be ours: refused before decoding. */
export const MAX_TOKEN = 4096;
const MAX_FRAMES = 2047;
const MAX_T = 30_000;
const SOURCES: GestureFrame['source'][] = ['touch', 'pointer', 'camera'];

/* ---------- the precision a sketch keeps (the session applies it live) ---------- */

const levels = (bits: number) => 2 ** bits - 1;
const q = (v: number, bits: number) => Math.round(Math.min(1, Math.max(0, v)) * levels(bits)) / levels(bits);

/** The frame as the engine sees it and the link carries it. */
export function quantize(raw: GestureFrame, t: number, previous: GestureFrame | undefined, source: GestureFrame['source']): GestureFrame {
  if (!raw.active) {
    return { t, active: false, x: previous?.x ?? 0.5, y: previous?.y ?? 0.5, speed: 0, openness: 0, spread: null, confidence: 1, source };
  }
  return {
    t,
    active: true,
    x: q(raw.x, 5),
    y: q(raw.y, 5),
    speed: q(raw.speed, 4),
    openness: q(raw.openness, 4),
    spread: raw.spread === null ? null : q(raw.spread, 4),
    confidence: 1,
    source,
  };
}

/* ---------- bits ---------- */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function writer() {
  const bits: number[] = [];
  return {
    put(value: number, width: number) {
      for (let i = width - 1; i >= 0; i -= 1) bits.push(Math.floor(value / 2 ** i) % 2);
    },
    token() {
      while (bits.length % 6) bits.push(0);
      let out = '';
      for (let i = 0; i < bits.length; i += 6) out += ALPHABET[bits.slice(i, i + 6).reduce((a, b) => a * 2 + b, 0)];
      return out;
    },
  };
}

function reader(token: string) {
  const bits: number[] = [];
  for (const c of token) {
    const v = ALPHABET.indexOf(c);
    for (let i = 5; i >= 0; i -= 1) bits.push((v >> i) & 1);
  }
  let at = 0;
  return {
    take(width: number): number {
      if (at + width > bits.length) throw new RangeError('truncated');
      let v = 0;
      for (let i = 0; i < width; i += 1) v = v * 2 + bits[at + i]!;
      at += width;
      return v;
    },
    /** Only padding (fewer than 6 bits, all zero) may be left. */
    clean: () => bits.length - at < 6 && bits.slice(at).every((b) => b === 0),
  };
}

/* ---------- encode / decode ---------- */

export function encodeSketch(sketch: Sketch): string {
  const w = writer();
  const preset = PRESETS.findIndex((p) => p.id === sketch.presetId);
  w.put(VERSION, 4);
  w.put(preset, 4);
  w.put(Math.max(0, SOURCES.indexOf(sketch.frames[0]?.source ?? 'touch')), 2);
  w.put(sketch.seed >>> 0, 32);
  w.put(sketch.frames.length, 11);
  let t = 0;
  for (const f of sketch.frames) {
    const dt = f.t - t;
    t = f.t;
    w.put(f.active ? 1 : 0, 1);
    if (dt < 127) w.put(dt, 7);
    else {
      w.put(127, 7);
      w.put(dt, 15);
    }
    if (!f.active) continue;
    w.put(Math.round(f.x * levels(5)), 5);
    w.put(Math.round(f.y * levels(5)), 5);
    w.put(Math.round(f.speed * levels(4)), 4);
    w.put(Math.round(f.openness * levels(4)), 4);
    w.put(f.spread === null ? 0 : 1, 1);
    if (f.spread !== null) w.put(Math.round(f.spread * levels(4)), 4);
  }
  return w.token();
}

export function decodeSketch(fragment: string): Sketch | null {
  const token = fragment.startsWith('#') ? fragment.slice(1) : fragment;
  if (!token || token.length > MAX_TOKEN || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const r = reader(token);
    if (r.take(4) !== VERSION) return null;
    const preset = PRESETS[r.take(4)];
    const source = SOURCES[r.take(2)];
    const seed = r.take(32);
    const count = r.take(11);
    if (!preset || !source || count < 2 || count > MAX_FRAMES) return null;
    const frames: GestureFrame[] = [];
    let t = 0;
    for (let i = 0; i < count; i += 1) {
      const active = r.take(1) === 1;
      let dt = r.take(7);
      if (dt === 127) dt = r.take(15);
      t += dt;
      if (t > MAX_T) return null;
      const previous = frames.at(-1);
      if (!active) {
        frames.push({ t, active, x: previous?.x ?? 0.5, y: previous?.y ?? 0.5, speed: 0, openness: 0, spread: null, confidence: 1, source });
        continue;
      }
      const x = r.take(5) / levels(5);
      const y = r.take(5) / levels(5);
      const speed = r.take(4) / levels(4);
      const openness = r.take(4) / levels(4);
      const spread = r.take(1) === 1 ? r.take(4) / levels(4) : null;
      frames.push({ t, active, x, y, speed, openness, spread, confidence: 1, source });
    }
    // A performance starts with a touch at 0 and ends lifted.
    if (frames[0]!.t !== 0 || !frames[0]!.active || frames.at(-1)!.active || !r.clean()) return null;
    return { version: 1, presetId: preset.id, seed, frames };
  } catch {
    return null;
  }
}

/** The page address with the sketch as its fragment (any old fragment replaced). */
export function shareUrl(base: string, sketch: Sketch): string {
  return `${base.split('#')[0]}#${encodeSketch(sketch)}`;
}
