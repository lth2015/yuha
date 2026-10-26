/**
 * Each preset can have its own scene, starting with 春江: a pale landscape in
 * YUHA's own palette. Faint distant mountains, a still lake, a sun that rises
 * with the performance, a few drifting petals. These pin the parts of the
 * picture that carry meaning, so a later change cannot quietly break them:
 * which preset gets which scene, the sun rising and staying in the sky, notes
 * landing on the water as ripples and in the sky as light, and everything
 * held pale.
 *
 * No database: pure functions.
 */
import { describe, expect, it } from 'vitest';
import { PRESETS } from '../apps/air/src/engine/presets.js';
import { HORIZON, ridge, splashFor, sceneFor, sunAt, lakeTone } from '../apps/air/src/play/scenes.js';

describe('which scene a preset is drawn in', () => {
  it('draws every preset on the lake landscape: it is the page’s background, not one preset’s', () => {
    for (const p of PRESETS) expect(sceneFor(p.id)).toBe('lake');
  });

  it('falls back to paper for a preset it does not know', () => {
    expect(sceneFor('no-such-preset')).toBe('paper');
  });
});

describe('the sun over the lake', () => {
  it('rises as the performance goes on', () => {
    const ys = [0, 0.25, 0.5, 0.75, 1].map((p) => sunAt(p).y);
    for (let i = 1; i < ys.length; i += 1) expect(ys[i]).toBeGreaterThan(ys[i - 1]!);
  });

  it('starts low behind the hills and never leaves the sky', () => {
    expect(sunAt(0).y).toBeGreaterThan(HORIZON);
    expect(sunAt(0).y).toBeLessThan(HORIZON + 0.15);
    expect(sunAt(1).y).toBeLessThan(0.9);
  });

  it('holds still outside 0…1 rather than leaving the frame', () => {
    expect(sunAt(-1)).toEqual(sunAt(0));
    expect(sunAt(5)).toEqual(sunAt(1));
  });
});

describe('the distant hills', () => {
  it('stand on the far shore and stay low, so the sky stays open', () => {
    for (const layer of [0, 1, 2]) {
      for (let x = 0; x <= 1; x += 0.01) {
        const y = ridge(layer, x);
        expect(y).toBeGreaterThan(HORIZON);
        expect(y).toBeLessThan(HORIZON + 0.2);
      }
    }
  });

  it('the farther a layer, the higher it reaches', () => {
    const peak = (layer: number) => Math.max(...Array.from({ length: 101 }, (_, i) => ridge(layer, i / 100)));
    expect(peak(0)).toBeGreaterThan(peak(2));
  });
});

describe('where a note lands', () => {
  it('on the water it is a ripple, in the sky it is light', () => {
    expect(splashFor(HORIZON - 0.1)).toBe('ripple');
    expect(splashFor(HORIZON + 0.1)).toBe('glow');
  });
});

describe('colour', () => {
  it('runs from warm petal for low notes to cool for high ones', () => {
    expect(lakeTone(48).hue).toBeLessThan(40);
    expect(lakeTone(84).hue).toBeGreaterThan(180);
  });

  it('stays pale: soft saturation and light, for every pitch', () => {
    for (let pitch = 30; pitch <= 100; pitch += 1) {
      const { sat, light } = lakeTone(pitch);
      expect(sat).toBeLessThanOrEqual(70);
      expect(light).toBeGreaterThanOrEqual(62);
    }
  });
});
