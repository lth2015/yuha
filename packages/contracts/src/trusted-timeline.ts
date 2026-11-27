import { LINE_CONFIDENT, type LyricTimings } from './generation.js';

type Line = LyricTimings['lines'][number];

/**
 * Whether a lyric line may be lit, burned into a video or written to an .lrc
 * (docs/agents/LYRIC_AUTO_SYNC_UX_HANDOFF.md, the shared rule). Every
 * consumer asks this, so the player, the videos and the .lrc cannot disagree.
 *
 *   corrected  every line: a person heard the song and placed it
 *   aligned    a line the aligner heard, unless it reported being unsure of
 *              it (confidence below LINE_CONFIDENT); no figure is an older
 *              timeline, trusted as it always was
 *   estimated  none under the strict rule: an estimate is for reading, and a
 *              highlight from it looks like a sync that never happened.
 *              `estimates: true` keeps the earlier behaviour for those not
 *              yet on the strict rule.
 */
export function isTrustedLine(
  timings: Pick<LyricTimings, 'source'>,
  line: Pick<Line, 'confidence'>,
  opts: { estimates?: boolean } = {},
): boolean {
  if (timings.source === 'corrected') return true;
  if (timings.source === 'aligned') return !(typeof line.confidence === 'number' && line.confidence < LINE_CONFIDENT);
  return opts.estimates === true;
}

/** The timeline with only its trusted lines; null for no timeline. */
export function trustedTimeline(
  timings: LyricTimings | null | undefined,
  opts: { estimates?: boolean } = {},
): LyricTimings | null {
  if (!timings) return null;
  return { ...timings, lines: timings.lines.filter((l) => isTrustedLine(timings, l, opts)) };
}
