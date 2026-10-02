/**
 * The three states `energy` actually has.
 *
 * `energy` leaves the browser as a float in 0..1 and arrives at the music
 * service as one of three words. Between those two facts sat a slider with a
 * percentage readout: a hundred positions for three outcomes, defaulting to
 * one that contributes nothing. Nobody could have noticed from the screen —
 * the control moved, the number changed, and the request was identical.
 *
 * These tests are the tripwire between the float and the words. The
 * thresholds below are a copy of the ones in build_tags_v2
 * (deploy/dgx/music/server/app.py), which is deployed separately and cannot be
 * imported from here, so a change to either side without the other fails here
 * rather than in a song whose only symptom is sounding wrong.
 *
 * No database: constants and one pure provider.
 */
import { describe, expect, it } from 'vitest';
import { ENERGY_LEVELS } from '@yuha/contracts';
import { LocalTextProvider } from '@yuha/providers';

/** Mirrors build_tags_v2 in deploy/dgx/music/server/app.py. */
const word = (e: number) => (e < 0.35 ? 'mellow' : e > 0.7 ? 'energetic' : '');

const intentFor = (energy: number) =>
  new LocalTextProvider().extractIntent({
    scene: 'daily_log',
    mode: 'simple' as const,
    prompt: 'a song',
    lyrics: null,
    styles: [],
    instrumental: true,
    title: null,
    energy,
    durationSeconds: 120,
  });

describe('energy levels', () => {
  it('offers exactly one level per band the music service can tell apart', () => {
    expect(ENERGY_LEVELS.map((l) => word(l.value))).toEqual(['mellow', '', 'energetic']);
  });

  it('keeps every level inside the range the schema and the service both accept', () => {
    for (const level of ENERGY_LEVELS) {
      expect(level.value, level.id).toBeGreaterThanOrEqual(0);
      expect(level.value, level.id).toBeLessThanOrEqual(1);
    }
  });

  it('names the middle level honestly: it adds no word of its own', () => {
    // Not a defect to fix by nudging the value — the middle band is "say
    // nothing about energy", and a creator who wants that should be able to
    // pick it. What was wrong was calling it 50% of something.
    const medium = ENERGY_LEVELS.find((l) => l.id === 'medium')!;
    expect(word(medium.value)).toBe('');
  });

  it('gives each level its own tempo, so the choice is audible twice over', async () => {
    const hints: string[] = [];
    for (const level of ENERGY_LEVELS) {
      const res = await intentFor(level.value);
      expect(res.status).toBe('ok');
      if (res.status !== 'ok') return;
      hints.push(res.intent.tempoHint);
    }
    expect(hints[0]).toBe('slow');
    expect(hints[2]).toBe('fast');
    expect(new Set(hints).size).toBe(3);
  });
});
