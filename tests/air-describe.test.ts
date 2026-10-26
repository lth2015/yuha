/**
 * The parameter card (#32): a sketch said back in words, in the vocabulary a
 * real song request uses.
 *
 * This is the rehearsal for phase 3, when the card's values become the request
 * itself, so the vocabulary is pinned to @yuha/contracts at runtime here even
 * though the page only imports its types (a runtime import would pull zod into
 * a page whose first sound has to arrive within a second):
 * - mood and tempo are members of the `Mood` and `TempoHint` enums;
 * - energy is one of the three ENERGY_LEVELS, never a float in between,
 *   because only three bands of it are distinguishable downstream.
 *
 * No database, no audio: pure.
 */
import { describe, expect, it } from 'vitest';
import { ENERGY_LEVELS, Mood, TempoHint } from '@yuha/contracts';
import type { GestureFrame } from '../apps/air/src/engine/frame.js';
import { AIR_ENERGY_LEVELS, describeSketch } from '../apps/air/src/engine/describe.js';
import { PRESETS } from '../apps/air/src/engine/presets.js';
import type { Sketch } from '../apps/air/src/engine/session.js';

type Gesture = { y: number; speed: number; openness?: number; spread?: number | null };

/** Ten seconds of one steady gesture at 20 Hz, closed with a lift, as a session would keep it. */
function sketchOf(g: Gesture, presetId = 'morning', extra: GestureFrame[] = []): Sketch {
  const frames: GestureFrame[] = [];
  for (let t = 0; t <= 10_000; t += 50) {
    frames.push({ t, active: true, x: 0.5, y: g.y, speed: g.speed, openness: g.openness ?? 0, spread: g.spread ?? null, confidence: 1, source: 'touch' });
  }
  frames.push(...extra, { ...frames.at(-1)!, t: 10_050 + extra.length * 50, active: false, speed: 0, openness: 0, spread: null });
  return { version: 1, presetId, seed: 1, frames };
}

const grid = [0, 0.25, 0.5, 0.75, 1];

describe('vocabulary shared with real song requests', () => {
  it('only ever says a mood, tempo and energy level the generation contract knows', () => {
    for (const preset of PRESETS) {
      for (const y of grid) {
        for (const speed of grid) {
          for (const openness of [0, 1]) {
            for (const spread of [null, 1]) {
              const card = describeSketch(sketchOf({ y, speed, openness, spread }, preset.id));
              expect(Mood.options).toContain(card.mood);
              expect(TempoHint.options).toContain(card.tempo);
              const level = ENERGY_LEVELS.find((l) => l.id === card.energy.id);
              expect(level, card.energy.id).toBeDefined();
              expect(card.energy.value).toBe(level!.value);
              expect(card.instrumental).toBe(true);
            }
          }
        }
      }
    }
  });

  it('keeps its copy of the three energy levels identical to the contract', () => {
    expect(AIR_ENERGY_LEVELS).toEqual(ENERGY_LEVELS);
  });

  it('can reach every mood the contract has, so none is dead vocabulary', () => {
    const seen = new Set<string>();
    for (const preset of PRESETS) {
      for (const y of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]) {
        for (const speed of [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]) {
          for (const openness of [0, 1]) seen.add(describeSketch(sketchOf({ y, speed, openness }, preset.id)).mood);
        }
      }
    }
    expect([...seen].sort()).toEqual([...Mood.options].sort());
  });
});

describe('what a gesture is called', () => {
  it('hears a high, slow hand as dreamy and unhurried', () => {
    const card = describeSketch(sketchOf({ y: 0.85, speed: 0.05 }));
    expect(card).toMatchObject({ mood: 'dreamy', tempo: 'slow', energy: { id: 'mellow' } });
  });

  it('hears a high, fast, open hand as uplifting', () => {
    const card = describeSketch(sketchOf({ y: 0.85, speed: 0.95, openness: 1 }));
    expect(card).toMatchObject({ mood: 'uplifting', tempo: 'fast', energy: { id: 'strong' } });
  });

  it('hears a low, slow hand as calm in a major preset and melancholic in a minor one', () => {
    expect(describeSketch(sketchOf({ y: 0.15, speed: 0.05 }, 'morning')).mood).toBe('calm');
    expect(describeSketch(sketchOf({ y: 0.15, speed: 0.05 }, 'night')).mood).toBe('melancholic');
  });

  it('hears a low, fast hand as tense', () => {
    expect(describeSketch(sketchOf({ y: 0.15, speed: 0.95 })).mood).toBe('tense');
  });

  it('lets the preset set the pace: the same gesture is slower in 江湖 than in 春', () => {
    const order = ['slow', 'medium', 'fast'];
    const g = { y: 0.5, speed: 0.5 };
    expect(order.indexOf(describeSketch(sketchOf(g, 'jianghu')).tempo)).toBeLessThan(order.indexOf(describeSketch(sketchOf(g, 'spring')).tempo));
  });

  it('only counts what was played: lifted frames do not change the card', () => {
    // Enough lifted frames, with extreme enough values, that counting them would change the card.
    const lifted: GestureFrame[] = Array.from({ length: 400 }, (_, i) => ({ t: 10_100 + i * 50, active: false, x: 0, y: 1, speed: 1, openness: 1, spread: null, confidence: 1, source: 'touch' }));
    const g = { y: 0.3, speed: 0.05 };
    const withLifts = describeSketch(sketchOf(g, 'morning', lifted));
    const without = describeSketch(sketchOf(g));
    expect({ ...withLifts, words: null }).toEqual({ ...without, words: null });
  });

  it('is the same every time for the same sketch', () => {
    const s = sketchOf({ y: 0.6, speed: 0.3, openness: 0.7 });
    expect(describeSketch(s)).toEqual(describeSketch(s));
  });
});

describe('the sentence', () => {
  it('reads like the spec’s example for a bright, wide, middling gesture', () => {
    const card = describeSketch(sketchOf({ y: 0.8, speed: 0.5, openness: 1 }));
    expect(card.words.zh).toBe('明亮、开阔、中速流动');
    expect(card.words.ja).toBe('明るく、広がり、流れるように');
    expect(card.words.en).toBe('bright, wide, flowing');
  });

  it('exists in all three languages for every gesture', () => {
    for (const y of grid) {
      for (const speed of grid) {
        const { words, moodName } = describeSketch(sketchOf({ y, speed }));
        for (const lang of ['zh', 'ja', 'en'] as const) {
          expect(words[lang].length).toBeGreaterThan(3);
          expect(moodName[lang].length).toBeGreaterThan(0);
        }
      }
    }
  });
});

/** Ten seconds of a hand whose height follows `y(fraction of the take)`, closed with a lift. */
function sketchAlong(y: (u: number) => number): Sketch {
  const frames: GestureFrame[] = [];
  for (let t = 0; t <= 10_000; t += 50) frames.push({ t, active: true, x: 0.5, y: y(t / 10_000), speed: 0.3, openness: 0, spread: null, confidence: 1, source: 'touch' });
  frames.push({ ...frames.at(-1)!, t: 10_050, active: false, speed: 0 });
  return { version: 1, presetId: 'morning', seed: 1, frames };
}

describe('the shape of what was played (phase 3: the material the lyrics are written from)', () => {
  it('hears a hand that climbs as rising, and one that sinks as falling', () => {
    expect(describeSketch(sketchAlong((u) => 0.15 + 0.7 * u)).arc).toBe('rise');
    expect(describeSketch(sketchAlong((u) => 0.85 - 0.7 * u)).arc).toBe('fall');
  });

  it('hears a hand that goes up and comes back as a wave', () => {
    expect(describeSketch(sketchAlong((u) => 0.3 + 0.5 * Math.sin(Math.PI * u))).arc).toBe('wave');
    expect(describeSketch(sketchAlong((u) => 0.75 - 0.5 * Math.sin(Math.PI * u))).arc).toBe('wave');
  });

  it('hears a hand that stays at one height as steady', () => {
    expect(describeSketch(sketchAlong(() => 0.5)).arc).toBe('steady');
    expect(describeSketch(sketchAlong((u) => 0.5 + 0.03 * Math.sin(20 * u))).arc).toBe('steady');
  });

  it('only counts what was played: a lifted finger does not bend the arc', () => {
    const s = sketchAlong(() => 0.5);
    s.frames.splice(100, 0, { ...s.frames[100]!, active: false, y: 0.95 });
    expect(describeSketch(s).arc).toBe('steady');
  });
});
