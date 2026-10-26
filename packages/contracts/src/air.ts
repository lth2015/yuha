import { Mood, TempoHint } from './enums.js';
import { ENERGY_LEVELS, type EnergyLevelId } from './generation.js';

/**
 * Air composition → /create (docs/AIR_PHASE3_SPEC.md). The air page's
 * parameter card links to `yuha.studio/create?air=<value>`, and /create fills
 * its form from it. The value is enum members only, joined by `-`:
 *
 *   2-<mood>-<tempo>-<energy>-<tone>-<space>-<arc>-<voice>
 *       e.g. 2-calm-slow-mellow-soft-wide-rise-sung
 *   1-<mood>-<tempo>-<energy>-<tone>-<space>     (still opened: an instrumental, no arc)
 *
 * `arc` is the shape of what was played (how the hand's height moved through
 * the take) and `voice` is the player's choice on the card: `sung` means AI
 * lyrics, as /create already writes for any sung request. Together they close
 * the loop from playing to a song with words.
 *
 * Never free text: /create writes the description from its own dictionary, so
 * a tampered link can at worst pick another valid sketch, and the words are
 * always in the reader's language rather than the sharer's. Anything that is
 * not exactly one of these shapes is rejected whole; there is no partial prefill.
 *
 * The air page only imports types from here (zod stays out of it), so
 * tests/air-prefill.test.ts checks that every link it can build parses.
 */
export const AIR_TONES = ['bright', 'soft', 'deep'] as const;
export type AirTone = (typeof AIR_TONES)[number];
export const AIR_SPACES = ['wide', 'close'] as const;
export type AirSpace = (typeof AIR_SPACES)[number];
export const AIR_ARCS = ['rise', 'fall', 'wave', 'steady'] as const;
export type AirArc = (typeof AIR_ARCS)[number];
export const AIR_VOICES = ['sung', 'inst'] as const;
export type AirVoice = (typeof AIR_VOICES)[number];

/** The version the air page writes. */
export const AIR_PREFILL_VERSION = '2';

export interface AirPrefill {
  mood: Mood;
  tempo: TempoHint;
  energy: EnergyLevelId;
  tone: AirTone;
  space: AirSpace;
  /** Null for a version 1 link, which did not carry it. */
  arc: AirArc | null;
  voice: AirVoice;
}

const has = <T extends string>(list: readonly T[], v: string | undefined): v is T => v !== undefined && (list as readonly string[]).includes(v);

export function parseAirPrefill(raw: string | null | undefined): AirPrefill | null {
  if (!raw || raw.length > 80) return null;
  const parts = raw.split('-');
  const [version, mood, tempo, energy, tone, space, arc, voice] = parts;
  if (!(version === '1' && parts.length === 6) && !(version === '2' && parts.length === 8)) return null;
  if (!has(Mood.options, mood) || !has(TempoHint.options, tempo)) return null;
  if (!has(ENERGY_LEVELS.map((l) => l.id), energy) || !has(AIR_TONES, tone) || !has(AIR_SPACES, space)) return null;
  if (version === '1') return { mood, tempo, energy, tone, space, arc: null, voice: 'inst' };
  if (!has(AIR_ARCS, arc) || !has(AIR_VOICES, voice)) return null;
  return { mood, tempo, energy, tone, space, arc, voice };
}
