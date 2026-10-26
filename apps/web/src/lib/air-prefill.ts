import { ENERGY_LEVELS, parseAirPrefill, type AirPrefill } from '@yuha/contracts';

/**
 * What /create does with `?air=` (docs/AIR_PHASE3_SPEC.md): a sketch from Air
 * composition, as enum values, turned into a filled form.
 *
 * The description is written here, from this app's dictionary in the reader's
 * language; the link carries no text. It fills only what the sketch decides:
 * the description, instrumental, the energy level and AI lyrics. Length,
 * styles and visibility stay at their defaults, for the creator to choose.
 * A draft the creator already wrote is never replaced without asking.
 *
 * Pure, so the whole decision is testable (tests/air-prefill.test.ts); the
 * page only applies it.
 */
export type AirFields = { prompt: string; instrumental: true; energy: number; lyricsBy: 'ai'; lyrics: '' };

export type AirPlan =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'fill'; fields: AirFields }
  | { kind: 'conflict'; fields: AirFields };

type Say = (key: string, vars?: Record<string, string>) => string;

// Spelled out so scripts/check-i18n.mjs can see every key in all three dictionaries.
const MOOD = {
  calm: 'create.air.mood.calm',
  dreamy: 'create.air.mood.dreamy',
  warm: 'create.air.mood.warm',
  melancholic: 'create.air.mood.melancholic',
  confident: 'create.air.mood.confident',
  playful: 'create.air.mood.playful',
  tense: 'create.air.mood.tense',
  uplifting: 'create.air.mood.uplifting',
} as const satisfies Record<AirPrefill['mood'], string>;
const MOTION = {
  slow: 'create.air.motion.slow',
  medium: 'create.air.motion.medium',
  fast: 'create.air.motion.fast',
} as const satisfies Record<AirPrefill['tempo'], string>;
const TONE = {
  bright: 'create.air.tone.bright',
  soft: 'create.air.tone.soft',
  deep: 'create.air.tone.deep',
} as const satisfies Record<AirPrefill['tone'], string>;
const SPACE = {
  wide: 'create.air.space.wide',
  close: 'create.air.space.close',
} as const satisfies Record<AirPrefill['space'], string>;

export function airPrefillPlan(param: string | null, stored: { prompt: string; lyrics: string }, say: Say): AirPlan {
  if (param === null) return { kind: 'none' };
  const sketch = parseAirPrefill(param);
  if (!sketch) return { kind: 'invalid' };
  const fields: AirFields = {
    prompt: say('create.air.prompt', {
      tone: say(TONE[sketch.tone]),
      space: say(SPACE[sketch.space]),
      motion: say(MOTION[sketch.tempo]),
      mood: say(MOOD[sketch.mood]),
    }),
    instrumental: true,
    energy: ENERGY_LEVELS.find((l) => l.id === sketch.energy)!.value,
    lyricsBy: 'ai',
    lyrics: '',
  };
  const written = stored.prompt.trim() !== '' || stored.lyrics.trim() !== '';
  return { kind: written ? 'conflict' : 'fill', fields };
}
