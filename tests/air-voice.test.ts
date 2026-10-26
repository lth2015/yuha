/**
 * The rules that shape a voice once a note is decided (#33 polish of 春江).
 *
 * The 春江花月夜 brief asks the sound to answer the gesture: low notes with long
 * tails (月升), a quicker, denser tremolo as the hand rises and brightens
 * (月照花林), and a slow fade to silence (落月摇情). These are fixed rules of the
 * voice, not chance, so a replay or a shared link plays them identically —
 * which is why they are pure functions with tests rather than synth code.
 *
 * No database, no audio: pure.
 */
import { describe, expect, it } from 'vitest';
import { releaseFor, tremoloStrikes, type TremoloRule } from '../apps/air/src/play/voice-rules.js';

const rule: TremoloRule = { rate: [8, 14], minMs: [700, 350], max: 7, fade: 0.8 };
const note = (over: { duration?: number; brightness?: number; velocity?: number } = {}) => ({
  duration: 1200,
  brightness: 0.5,
  velocity: 0.8,
  ...over,
});

describe('tremolo (轮指)', () => {
  it('re-strikes only notes long enough for it', () => {
    expect(tremoloStrikes(rule, note({ duration: 300, brightness: 1 }))).toEqual([]);
    expect(tremoloStrikes(rule, note({ duration: 2000 })).length).toBeGreaterThan(0);
  });

  it('starts on shorter notes as the hand rises and brightens', () => {
    const d = 500;
    expect(tremoloStrikes(rule, note({ duration: d, brightness: 0.1 }))).toEqual([]);
    expect(tremoloStrikes(rule, note({ duration: d, brightness: 0.9 })).length).toBeGreaterThan(0);
  });

  it('is quicker and denser higher up', () => {
    const gap = (s: { atMs: number }[]) => (s.length > 1 ? s[1]!.atMs - s[0]!.atMs : Infinity);
    const lo = tremoloStrikes(rule, note({ duration: 2000, brightness: 0 }));
    const hi = tremoloStrikes(rule, note({ duration: 2000, brightness: 1 }));
    expect(gap(hi)).toBeLessThan(gap(lo));
    // A note short enough that neither hits the cap: higher up, more strikes in it.
    const count = (brightness: number) => tremoloStrikes(rule, note({ duration: 800, brightness })).length;
    expect(count(1)).toBeGreaterThan(count(0));
  });

  it('never runs past the note, never exceeds its cap, and fades', () => {
    for (const brightness of [0, 0.5, 1]) {
      for (const duration of [400, 900, 3000, 10_000]) {
        const s = tremoloStrikes(rule, note({ duration, brightness }));
        expect(s.length).toBeLessThan(rule.max);
        for (let i = 0; i < s.length; i += 1) {
          expect(s[i]!.atMs).toBeGreaterThan(0);
          expect(s[i]!.atMs).toBeLessThan(duration);
          expect(s[i]!.durationMs).toBe(duration - s[i]!.atMs);
          if (i > 0) expect(s[i]!.velocity).toBeLessThan(s[i - 1]!.velocity);
        }
      }
    }
  });

  it('is the same every time for the same note', () => {
    expect(tremoloStrikes(rule, note({ duration: 2500, brightness: 0.7 }))).toEqual(tremoloStrikes(rule, note({ duration: 2500, brightness: 0.7 })));
  });
});

describe('release (余音)', () => {
  it('rings longer for lower, darker notes when the voice asks for it', () => {
    expect(releaseFor(0.4, 1.5, 0)).toBeGreaterThan(releaseFor(0.4, 1.5, 1));
    expect(releaseFor(0.4, 1.5, 1)).toBe(0.4);
    expect(releaseFor(0.4, 1.5, 0)).toBeCloseTo(1.0);
  });

  it('changes nothing for a voice that does not ask (every preset but 春江)', () => {
    for (const b of [0, 0.5, 1]) expect(releaseFor(0.25, 0, b)).toBe(0.25);
  });
});
