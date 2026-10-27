import { ENERGY_LEVELS, parseAirPrefill, type AirPrefill } from '@yuha/contracts';

/**
 * What /create does with `?air=` (docs/AIR_PHASE3_SPEC.md): a sketch from Air
 * composition, as enum values, turned into a filled form.
 *
 * The description is written here, from this app's dictionary in the reader's
 * language; the link carries no text. It fills only what the sketch decides:
 * the description (with the shape of what was played, the material the music
 * and the AI's lyrics are written from), sung or instrumental as the player
 * chose on the card, the energy level, and AI lyrics. Length, styles and
 * visibility stay at their defaults, for the creator to choose.
 *
 * Pressing 「去 YUHA」 is the creator asking for this sketch, so the sketch
 * always fills the form. It used to ask first when a draft existed; the form
 * then stayed on the old draft behind a banner (人声 after choosing 纯音乐),
 * and every earlier visit from Air leaves such a draft. A draft the creator
 * wrote is set aside (`setAside`) for the page to offer back, never lost.
 *
 * Pure, so the whole decision is testable (tests/air-prefill.test.ts); the
 * page only applies it.
 */
export type AirFields = { prompt: string; instrumental: boolean; energy: number; lyricsBy: 'ai'; lyrics: '' };

export type AirPlan =
  | { kind: 'none' }
  | { kind: 'invalid' }
  | { kind: 'fill'; fields: AirFields; setAside: boolean };

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
const ARC = {
  rise: 'create.air.arc.rise',
  fall: 'create.air.arc.fall',
  wave: 'create.air.arc.wave',
  steady: 'create.air.arc.steady',
} as const satisfies Record<NonNullable<AirPrefill['arc']>, string>;

export function airPrefillPlan(param: string | null, stored: { prompt: string; lyrics: string }, say: Say): AirPlan {
  if (param === null) return { kind: 'none' };
  const sketch = parseAirPrefill(param);
  if (!sketch) return { kind: 'invalid' };
  const words = {
    tone: say(TONE[sketch.tone]),
    space: say(SPACE[sketch.space]),
    motion: say(MOTION[sketch.tempo]),
    mood: say(MOOD[sketch.mood]),
  };
  const sung = sketch.voice === 'sung';
  // A version 1 link has no arc and was always an instrumental: its sentence is unchanged.
  const prompt = sketch.arc === null
    ? say('create.air.prompt', words)
    : say(sung ? 'create.air.promptSung' : 'create.air.promptArc', { ...words, arc: say(ARC[sketch.arc]) });
  const fields: AirFields = {
    prompt,
    instrumental: !sung,
    energy: ENERGY_LEVELS.find((l) => l.id === sketch.energy)!.value,
    lyricsBy: 'ai',
    lyrics: '',
  };
  const written = stored.prompt.trim() !== '' || stored.lyrics.trim() !== '';
  return { kind: 'fill', fields, setAside: written };
}

/**
 * Lyrics written ahead (POST /v1/lyrics/draft) arrive a few seconds after the
 * page. By then the creator may have switched to instrumental, started typing
 * lyrics, or restored an earlier draft: any of those wins, and the arrival is
 * dropped rather than written over their choice. Otherwise the lyrics go into
 * the box as the creator's own, to edit, so generation sings them as written.
 */
export function withDraftedLyrics<D extends { instrumental: boolean; lyrics: string; lyricsBy: 'ai' | 'me' }>(draft: D, lyrics: string): D {
  if (draft.instrumental || draft.lyrics.trim() !== '') return draft;
  return { ...draft, lyrics, lyricsBy: 'me' };
}
