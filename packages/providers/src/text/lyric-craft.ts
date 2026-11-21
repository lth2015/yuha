/**
 * The lyric-writing rules every text adapter gives its model
 * (docs/LYRICS_MODEL.md), so a comparison between models compares models
 * and not prompts.
 */

/**
 * "4-5" for 4.5, "6" for 6: the prompt has always said "one short line per 4-5
 * seconds", and the default must keep producing that exact sentence.
 */
function lineSpan(seconds: number): string {
  const lo = Math.floor(seconds);
  const hi = Math.ceil(seconds);
  return lo === hi ? String(lo) : `${lo}-${hi}`;
}

/**
 * How to write words that will be sung, aligned and read along with.
 *
 * Each rule is there for something the songs or the aligner have shown:
 * digits and Latin abbreviations are where forced alignment loses its place
 * (docs/quality/probe-set.json tests exactly those), a line too long for its
 * bar gets rushed or dropped by the singer, and a chorus with no repeated
 * hook is what makes a generated song forgettable.
 */
export const LYRIC_CRAFT = (secondsPerLine: number): string[] => [
  'How to write them:',
  '- Every lyric line is in the language of user_text: English text gets English lyrics, Japanese',
  '  text Japanese lyrics, Chinese text Chinese lyrics. The examples below in other languages only',
  '  illustrate the rules; they never choose the language.',
  `- Size them to durationSeconds: about one short line per ${lineSpan(secondsPerLine)} seconds of song.`,
  '- Section them with tags on their own lines in square brackets, from [intro] [verse]',
  '  [pre-chorus] [chorus] [bridge] [rap] [interlude] [instrumental] [solo] [outro] (the tags',
  '  the music model reads). Begin with [verse]. A song of a minute or more',
  '  has a [chorus], and the chorus returns at least once, unchanged or nearly so.',
  '- The chorus carries one short hook line that says the feeling plainly; the verses carry',
  '  concrete images taken from the creator\'s description (a place, a time, an object), not',
  '  abstractions and not stock phrases.',
  '- Lines are short and singable: within a section, keep lines close in length and rhythm',
  '  (Japanese: similar mora counts; Chinese: similar character counts with natural end rhyme;',
  '  English: similar stress counts with rhyme or near-rhyme at line ends).',
  '- Write every number as words in the lyric language (Japanese 三、ふたつ; Chinese 三; English',
  '  three), never digits. Avoid Latin-letter abbreviations and symbols in Chinese and Japanese',
  '  lyrics unless the creator wrote them. Japanese: kanji and kana as a person would write a',
  '  song, no romaji, no rare readings that a singer could get wrong.',
  '- Original words only: never quote or imitate existing songs, artists or titles.',
];
