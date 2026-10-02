/**
 * Lyric section markers: what counts as one, and what to call it upstream.
 *
 * A creator writing lyrics marks structure with bracketed lines — `[verse]`,
 * `[副歌]`, `[间奏]`. Two things used to go wrong with those.
 *
 * The first is that only nine English words were recognised. Anything else —
 * `[rap]`, `[高潮部分]`, `[中間節奏]` — fell through to the "this is a lyric"
 * branch, so the marker was laid out on the time axis as a line to be sung and
 * displayed to the listener as if it were part of the song. A structure hint
 * being sung aloud is the loudest possible way to get this wrong, and it was
 * silent: nothing warned, the song simply had a word in it that nobody wrote.
 *
 * The second is that the music model is given English structure tags. A
 * marker in Chinese or Japanese is meaningful to the person writing it and
 * meaningless to the model, so the two needs are separated here: `sectionName`
 * decides what the creator sees and how the timeline is cut, and
 * `canonicalSectionTag` decides what the model is told.
 *
 * Shared rather than duplicated: the timeline is built twice, in
 * `apps/web/src/lib/lyrics.ts` and `packages/providers/src/alignment/
 * estimated.ts`, and the last time those two held a copy each of the same
 * rule they also held a copy each of the same bug.
 */

/**
 * A line that is nothing but a square-bracketed token is always a marker.
 *
 * Square brackets are the structure convention; round brackets are not — a
 * line of `(ooh ooh)` is backing vocals and must stay a sung line. So round
 * brackets only count as a marker when the name inside is one we recognise.
 */
const SQUARE_RE = /^\s*\[\s*([^\]]{1,40}?)\s*\]\s*$/;
const PAREN_RE = /^\s*\(\s*([^)]{1,40}?)\s*\)\s*$/;

/**
 * Canonical English tags, with the names creators actually type for each.
 *
 * Ordered: `pre-chorus` is tested before `chorus` so it is not swallowed by it.
 * A trailing number (`Verse 2`, `主歌1`) is stripped before matching, because
 * it numbers the section rather than naming a different one.
 */
const SYNONYMS: Array<[RegExp, string]> = [
  [/^(intro|前奏|序奏|イントロ)$/iu, 'intro'],
  [/^(pre[\s-]?chorus|预副歌|預副歌|bメロ)$/iu, 'pre-chorus'],
  [/^(chorus|hook|refrain|副歌|高潮|高潮部分|サビ)$/iu, 'chorus'],
  [/^(verse|主歌|詩|バース|aメロ)$/iu, 'verse'],
  [/^(bridge|桥段|橋段|过渡|過渡|ブリッジ|cメロ)$/iu, 'bridge'],
  [/^(rap|说唱|說唱|饶舌|饒舌|ラップ)$/iu, 'rap'],
  [/^(interlude|间奏|間奏|中间节奏|中間節奏)$/iu, 'interlude'],
  [/^(instrumental|inst|纯音乐|純音樂|演奏)$/iu, 'instrumental'],
  [/^(solo|独奏|獨奏|ソロ)$/iu, 'solo'],
  [/^(outro|ending|尾奏|结尾|結尾|アウトロ)$/iu, 'outro'],
];

/**
 * The marker name on this line, or null when the line is lyrics.
 *
 * The name is returned as written, so the creator's own `[高潮部分]` is what
 * they see back on the song page.
 */
export function sectionName(line: string): string | null {
  const square = SQUARE_RE.exec(line);
  if (square) return square[1]!;
  const paren = PAREN_RE.exec(line);
  if (paren && canonicalSectionTag(paren[1]!) !== null) return paren[1]!;
  return null;
}

/** The English tag a marker means, or null when we do not recognise the name. */
export function canonicalSectionTag(name: string): string | null {
  const bare = name.trim().replace(/[\s_-]*\d+$/u, '').trim();
  for (const [re, tag] of SYNONYMS) {
    if (re.test(bare)) return tag;
  }
  return null;
}

/**
 * The lyrics as the music model should receive them: recognised markers
 * rewritten to their English tag, everything else untouched.
 *
 * Unrecognised markers are passed through rather than dropped. Dropping would
 * be guessing that the model cannot use them; passing them through at least
 * keeps the creator's structure visible to it. Which tags the model actually
 * acts on is not established — see docs/OPEN_ITEMS.md — so this canonicalises
 * toward the set the intent prompt has always asked for and claims nothing
 * more.
 */
export function withCanonicalSections(lyrics: string): string {
  return lyrics
    .split(/\r?\n/)
    .map((line) => {
      const name = sectionName(line);
      if (name === null) return line;
      const tag = canonicalSectionTag(name);
      return tag === null ? line : `[${tag}]`;
    })
    .join('\n');
}
