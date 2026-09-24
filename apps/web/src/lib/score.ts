/**
 * The score: a piece of writing read as music.
 *
 * This is the product's one idea made visible. A description is a sequence of
 * characters, and a melody is a sequence of notes, so the mapping is direct
 * rather than decorative: each character becomes a note, each word a phrase,
 * each punctuation mark a rest. Nothing here is random — the same sentence
 * always draws the same score, which is what lets the shape you watched while
 * writing become the sleeve of the finished song.
 *
 * The mapping is deliberately *legible*: type a longer sentence and the score
 * grows; write in short words and it breaks into many phrases; add a comma and
 * a gap opens. A hash would have been easier and would have looked like noise.
 */

/** One drawn mark. `rest` marks carry no pitch and render as a gap. */
export interface Note {
  /** 0..1 along the score. */
  x: number;
  /** 0..1 from the baseline; 0 for rests. */
  pitch: number;
  /** 0..1 — drives stroke weight and glow. */
  weight: number;
  /** Index of the phrase (word) this note belongs to. */
  phrase: number;
  rest: boolean;
}

export interface Score {
  notes: Note[];
  /** Number of phrases — words, roughly. */
  phrases: number;
  /** 0..1, how densely packed the writing is. */
  density: number;
  /** Stable integer derived from the text; the cover art shares it. */
  seed: number;
}

const RESTS = new Set([' ', '\n', '\t', '，', '。', '、', ',', '.', '!', '?', '！', '？', '…', '—', '；', ';', ':', '：']);

/**
 * A scale, not a continuum. Mapping character codes straight to pixel heights
 * gives a jagged mess; quantising to degrees of a pentatonic scale is what
 * makes an arbitrary sentence read as *music* rather than as a bar chart of
 * Unicode.
 */
const DEGREES = [0, 0.14, 0.29, 0.45, 0.58, 0.72, 0.86, 1];

/** FNV-1a over the code points — stable across platforms, unlike hashCode. */
export function seedFromText(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Reads `text` as a score. `max` caps the note count so a long paragraph stays
 * drawable — beyond it the writing is sampled evenly rather than truncated, so
 * the shape still reflects the whole text.
 */
export function scoreFromText(text: string, max = 96): Score {
  const chars = [...text.trim()];
  if (chars.length === 0) {
    return { notes: [], phrases: 0, density: 0, seed: seedFromText('') };
  }

  const step = chars.length > max ? chars.length / max : 1;
  const picked: string[] = [];
  for (let i = 0; i < chars.length; i += step) picked.push(chars[Math.floor(i)]!);

  const notes: Note[] = [];
  let phrase = 0;
  let sincePhrase = 0;

  picked.forEach((ch, i) => {
    const rest = RESTS.has(ch);
    if (rest) {
      // A rest closes the phrase; consecutive rests do not open empty ones.
      if (sincePhrase > 0) {
        phrase += 1;
        sincePhrase = 0;
      }
      notes.push({ x: i / (picked.length - 1 || 1), pitch: 0, weight: 0, phrase, rest: true });
      return;
    }
    const code = ch.codePointAt(0)!;
    const degree = DEGREES[code % DEGREES.length]!;
    // Letters later in a word sit slightly higher: phrases lift as they run,
    // which is what stops every word looking like the same shrub.
    const lift = Math.min(sincePhrase, 6) * 0.03;
    notes.push({
      x: i / (picked.length - 1 || 1),
      pitch: Math.min(1, degree * 0.86 + lift),
      // CJK code points are large; the low bits vary enough to read as accent.
      weight: 0.45 + ((code >> 3) % 7) / 12,
      phrase,
      rest: false,
    });
    sincePhrase += 1;
  });

  const sounded = notes.filter((n) => !n.rest).length;
  return {
    notes,
    phrases: phrase + (sincePhrase > 0 ? 1 : 0),
    density: sounded / notes.length,
    seed: seedFromText(text.trim()),
  };
}

/**
 * A score from a bare number, for songs whose text is not at hand — a library
 * card only carries the track's `coverSeed`.
 *
 * It walks the same note/rest/phrase model as `scoreFromText`, so a sleeve and
 * the band you watched while writing are visibly the same kind of object. The
 * two are not yet the *same* score: that needs the server to derive
 * `coverSeed` from the prompt rather than from the track id.
 */
export function scoreFromSeed(seed: number, count = 44): Score {
  let a = (seed || 9) >>> 0;
  const rnd = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const notes: Note[] = [];
  let phrase = 0;
  let sincePhrase = 0;
  for (let i = 0; i < count; i += 1) {
    // Rests cluster the way they do in writing: never at the start, never two
    // in a row, and more likely once a phrase has run on a while.
    const rest = i > 0 && sincePhrase > 1 && rnd() < 0.1 + sincePhrase * 0.04;
    const x = i / (count - 1);
    if (rest) {
      phrase += 1;
      sincePhrase = 0;
      notes.push({ x, pitch: 0, weight: 0, phrase, rest: true });
      continue;
    }
    const degree = DEGREES[Math.floor(rnd() * DEGREES.length)]!;
    const lift = Math.min(sincePhrase, 6) * 0.03;
    notes.push({
      x,
      pitch: Math.min(1, degree * 0.86 + lift),
      weight: 0.45 + rnd() * 0.5,
      phrase,
      rest: false,
    });
    sincePhrase += 1;
  }
  const sounded = notes.filter((n) => !n.rest).length;
  return { notes, phrases: phrase + 1, density: sounded / notes.length, seed: seed >>> 0 };
}
