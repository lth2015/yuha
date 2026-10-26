import { Mood, TempoHint } from './enums.js';
import { ENERGY_LEVELS, type EnergyLevelId } from './generation.js';

/**
 * Air composition → /create (docs/AIR_PHASE3_SPEC.md). The air page's
 * parameter card links to `yuha.studio/create?air=<value>`, and /create fills
 * its form from it. The value is enum members only, joined by `-`:
 *
 *   1-<mood>-<tempo>-<energy>-<tone>-<space>     e.g. 1-calm-slow-mellow-soft-wide
 *
 * Never free text: /create writes the description from its own dictionary, so
 * a tampered link can at worst pick another valid sketch, and the words are
 * always in the reader's language rather than the sharer's. Anything that is
 * not exactly this shape is rejected whole; there is no partial prefill.
 *
 * The air page only imports types from here (zod stays out of it), so
 * tests/air-prefill.test.ts checks that every link it can build parses.
 */
export const AIR_TONES = ['bright', 'soft', 'deep'] as const;
export type AirTone = (typeof AIR_TONES)[number];
export const AIR_SPACES = ['wide', 'close'] as const;
export type AirSpace = (typeof AIR_SPACES)[number];

export const AIR_PREFILL_VERSION = '1';

export interface AirPrefill {
  mood: Mood;
  tempo: TempoHint;
  energy: EnergyLevelId;
  tone: AirTone;
  space: AirSpace;
}

const has = <T extends string>(list: readonly T[], v: string | undefined): v is T => v !== undefined && (list as readonly string[]).includes(v);

export function parseAirPrefill(raw: string | null | undefined): AirPrefill | null {
  if (!raw || raw.length > 64) return null;
  const parts = raw.split('-');
  if (parts.length !== 6 || parts[0] !== AIR_PREFILL_VERSION) return null;
  const [, mood, tempo, energy, tone, space] = parts;
  if (!has(Mood.options, mood) || !has(TempoHint.options, tempo)) return null;
  if (!has(ENERGY_LEVELS.map((l) => l.id), energy) || !has(AIR_TONES, tone) || !has(AIR_SPACES, space)) return null;
  return { mood, tempo, energy, tone, space };
}
