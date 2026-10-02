/**
 * 温度 — how warm a song reads, as a number between 1 and 99.
 *
 * This replaces a label that meant nothing. The cover used to carry
 * `N°{random}` — three digits derived from the cover seed by
 * `1 + floor(rand() * 999)`, imitating a catalogue number on a record sleeve.
 * It was decoration, but it did not read as decoration: it read as an
 * identifier, two songs could carry the same one, and the first question
 * anybody asked about it was what it meant. A thing that invites that
 * question has already failed; the honest options were to remove it or to
 * make it true.
 *
 * So it is true now. Warmth is ours — nobody else's scale, no claim to
 * measure anything physical — but it is computed from what the song actually
 * is, not from a seed. The same song always reads the same, two songs that
 * sound alike read alike, and the styles it is computed from are printed on
 * the card beside it, so the number can be checked against its own inputs by
 * eye.
 *
 * What it is NOT: a quality score, a ranking, or anything to sort by. 20 is
 * not worse than 80, it is colder.
 */
import type { Mood, VocalMode } from './enums.js';

/**
 * Where each mood sits before anything else is taken into account.
 *
 * Spread across the range rather than bunched near the middle, because a
 * reading that is always between 45 and 55 tells nobody anything.
 */
const MOOD_WARMTH: Record<Mood, number> = {
  warm: 78,
  uplifting: 72,
  playful: 70,
  confident: 60,
  dreamy: 48,
  calm: 44,
  melancholic: 26,
  tense: 18,
};

/**
 * Style tags we have an opinion about, and how far each one pulls.
 *
 * Only tags we actually know appear here. A creator can type any tag they
 * like, and an unrecognised one contributes nothing rather than being hashed
 * into a number — hashing is how the old label got to be meaningless, and
 * doing it again behind a better name would be worse, not better.
 */
const STYLE_WARMTH: Record<string, number> = {
  soul: 9, acoustic: 8, folk: 7, jazz: 6, bossa: 6, 'chinese traditional': 6, guzheng: 6,
  lofi: 5, ballad: 4, piano: 4, 'city pop': 4, pop: 2,
  rock: -2, hyperpop: -2, cinematic: -3, house: -4, synthwave: -4, edm: -6, ambient: -6,
  techno: -8, trap: -8, dnb: -8, drill: -8, metal: -8,
};

/** A voice reads warmer than no voice. Small, because it is not the song's mood. */
const VOCAL_WARMTH: Record<VocalMode, number> = { with_vocals: 4, instrumental: -4 };

export interface WarmthInput {
  mood?: Mood | string | null;
  styles?: readonly string[];
  vocalMode?: VocalMode | null;
}

/**
 * The reading, or null when there is nothing to read it from.
 *
 * Null rather than a default: a song whose mood was never recorded and whose
 * tags we do not recognise has told us nothing about its warmth, and printing
 * 50 would be the old lie in a new place. The badge is simply absent there.
 */
export function songWarmth(input: WarmthInput): number | null {
  const mood = input.mood && input.mood in MOOD_WARMTH ? MOOD_WARMTH[input.mood as Mood] : null;

  let styleShift = 0;
  let knownStyles = 0;
  for (const raw of input.styles ?? []) {
    const shift = STYLE_WARMTH[raw.trim().toLowerCase()];
    if (shift === undefined) continue;
    styleShift += shift;
    knownStyles += 1;
  }
  if (mood === null && knownStyles === 0) return null;

  // Averaged, not summed: three warm tags describe one song more precisely,
  // they do not make it three times warmer.
  const styles = knownStyles > 0 ? styleShift / knownStyles : 0;
  const base = mood ?? 50;
  const voice = input.vocalMode ? VOCAL_WARMTH[input.vocalMode] : 0;

  return Math.min(99, Math.max(1, Math.round(base + styles + voice)));
}
