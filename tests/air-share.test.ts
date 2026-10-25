/**
 * A sketch as a link (#31): small enough for any messenger, the same music
 * on the other end, and harmless when it is broken or hostile.
 *
 * The link carries the gesture in its #fragment, which a browser never sends
 * to a server. Three promises, each a test:
 * - What a friend hears is what was played: the decoded sketch replays to the
 *   live events field by field. That holds because the session already
 *   quantises what the engine sees to what the link can carry.
 * - The whole URL, as UTF-8, is at most 4,096 bytes for the worst 30 seconds
 *   anyone could play — checked against adversarial gestures, not typical ones.
 * - Anything malformed decodes to "no sketch", without throwing, and an
 *   oversized fragment is refused before any of it is decoded.
 *
 * No database, no audio: pure.
 */
import { describe, expect, it } from 'vitest';
import type { GestureFrame } from '../apps/air/src/engine/frame.js';
import { createPerformer, perform, type NoteEvent } from '../apps/air/src/engine/performer.js';
import { PRESETS } from '../apps/air/src/engine/presets.js';
import { createSession, type Sketch } from '../apps/air/src/engine/session.js';
import { decodeSketch, encodeSketch, MAX_TOKEN, shareUrl } from '../apps/air/src/engine/share.js';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

type Shape = 'wander' | 'frantic' | 'max' | 'two-fingers-everything';

/** 60 Hz input for 40 s, in several shapes, the worst of them on purpose. */
function input(seed: number, shape: Shape): GestureFrame[] {
  const r = rng(seed);
  const out: GestureFrame[] = [];
  let active = false;
  for (let t = 0; t <= 40_000; t += 1000 / 60) {
    if (shape === 'wander') {
      if (t > 300 && r() < 0.01) active = !active;
      if (t > 100 && t < 300) active = true;
    } else if (shape === 'frantic') {
      active = t > 100 && r() < 0.5; // a new touch or lift on half the frames
    } else {
      active = t > 100;
    }
    const big = shape === 'max' || shape === 'two-fingers-everything';
    out.push({
      t: 54_321.7 + t,
      active,
      x: big ? (t % 2 ? 1 : 0) : r(),
      y: big ? (t % 3 ? 0 : 1) : r(),
      speed: big ? 1 : r(),
      openness: big ? 1 : r(),
      spread: shape === 'two-fingers-everything' ? r() : r() < 0.5 ? null : r(),
      confidence: 1,
      source: 'touch',
    });
  }
  return out;
}

/** Through the session, as the page does, performing live. */
function play(seed: number, shape: Shape) {
  const session = createSession({ presetId: PRESETS[0]!.id, seed });
  const performer = createPerformer(PRESETS[0]!, seed);
  const events: NoteEvent[] = [];
  for (const f of input(seed, shape)) {
    const out = session.push(f);
    if (out.frame) events.push(...performer.push(out.frame));
    if (out.status === 'ended') return { events, sketch: out.sketch };
  }
  throw new Error('performance did not end');
}

const SHAPES: Shape[] = ['wander', 'frantic', 'max', 'two-fingers-everything'];
/** Longer than any page this will be served from, so the limit holds with room to spare. */
const BASE = `https://yuha.studio/air/${'x'.repeat(60)}`;

describe('round trip', () => {
  it('gives back exactly the sketch that was encoded', () => {
    for (const shape of SHAPES) {
      for (const seed of [1, 2, 3]) {
        const { sketch } = play(seed, shape);
        expect(decodeSketch(encodeSketch(sketch)), `${shape} ${seed}`).toEqual(sketch);
      }
    }
  });

  it('replays on the other end to exactly the live events', () => {
    for (const shape of SHAPES) {
      for (const seed of [4, 5]) {
        const { events, sketch } = play(seed, shape);
        const received = decodeSketch(encodeSketch(sketch))!;
        expect(perform(PRESETS.find((p) => p.id === received.presetId)!, received.seed, received.frames), `${shape} ${seed}`).toEqual(events);
      }
    }
  });

  it('uses only characters a plain #anchor may carry', () => {
    const { sketch } = play(6, 'wander');
    expect(encodeSketch(sketch)).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('size', () => {
  it('keeps the whole link within 4,096 UTF-8 bytes for the worst 30 seconds', () => {
    let worst = 0;
    for (const shape of SHAPES) {
      for (let seed = 1; seed <= 8; seed += 1) {
        const url = shareUrl(BASE, play(seed, shape).sketch);
        worst = Math.max(worst, new TextEncoder().encode(url).length);
      }
    }
    expect(worst).toBeLessThanOrEqual(4096);
  });

  it('builds the link from the page address, replacing any fragment already there', () => {
    const { sketch } = play(7, 'wander');
    const url = shareUrl('https://example.test/air/?a=1#old', sketch);
    expect(url.startsWith('https://example.test/air/?a=1#')).toBe(true);
    expect(decodeSketch(new URL(url).hash)).toEqual(sketch);
  });
});

describe('broken and hostile links', () => {
  const good = encodeSketch(play(8, 'wander').sketch);

  it('decode to no sketch, without throwing', () => {
    const bad = [
      '',
      '#',
      '#both', // a probe link
      'not base64!!',
      good.slice(0, 10),
      good.slice(0, -7),
      `${good}AAAA`, // trailing bytes
      `A${good.slice(1)}`, // another version
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      '_'.repeat(400),
    ];
    for (const token of bad) expect(decodeSketch(token), token.slice(0, 20)).toBeNull();
  });

  it('refuses a well-formed sketch that is simply too long for a link', () => {
    // 2,000 frames all down with two fingers: valid in every field, far over 4 KB.
    const frames = Array.from({ length: 2000 }, (_, i) => ({
      t: i * 15,
      active: i < 1999,
      x: 1,
      y: 0,
      speed: 1,
      openness: 1,
      spread: i < 1999 ? 1 : null,
      confidence: 1,
      source: 'touch' as const,
    }));
    const token = encodeSketch({ version: 1, presetId: PRESETS[0]!.id, seed: 1, frames });
    expect(token.length).toBeGreaterThan(MAX_TOKEN);
    expect(decodeSketch(token)).toBeNull();
  });

  it('refuses an oversized fragment before reading it', () => {
    expect(decodeSketch('A'.repeat(MAX_TOKEN + 1))).toBeNull();
    expect(decodeSketch('A'.repeat(2_000_000))).toBeNull();
  });

  it('never yields a sketch longer than 30 seconds or with time running backwards', () => {
    // Flip every bit of a real link in turn: whatever decodes must still be sane.
    const bytes = [...good];
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    for (let i = 0; i < bytes.length; i += 1) {
      const mutated = [...bytes];
      mutated[i] = alphabet[(alphabet.indexOf(bytes[i]!) + 17) % 64]!;
      const sketch: Sketch | null = decodeSketch(mutated.join(''));
      if (!sketch) continue;
      expect(sketch.frames.at(-1)!.t).toBeLessThanOrEqual(30_000);
      for (let j = 1; j < sketch.frames.length; j += 1) expect(sketch.frames[j]!.t).toBeGreaterThanOrEqual(sketch.frames[j - 1]!.t);
      for (const f of sketch.frames) for (const v of [f.x, f.y, f.speed, f.openness]) expect(v >= 0 && v <= 1).toBe(true);
    }
  });
});
