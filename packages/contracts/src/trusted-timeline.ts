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

/**
 * An aligned line that starts on top of the one before it: a forced aligner
 * that ran out of voice piles the remaining lines onto one instant, each
 * marked sure (seen in production, 2026-11-27: nineteen lines at 93.5 s).
 * The DGX now marks those unsure itself; this keeps timelines stored before
 * that from flashing nineteen lines at once.
 */
export const STACKED_LINE_SECONDS = 0.05;

/** Per line, whether it may be lit: isTrustedLine, and not stacked on the line before it. */
export function trustedMask(timings: LyricTimings, opts: { estimates?: boolean } = {}): boolean[] {
  return timings.lines.map((l, i) => {
    if (!isTrustedLine(timings, l, opts)) return false;
    if (timings.source !== 'aligned' || i === 0) return true;
    return l.start - timings.lines[i - 1]!.start >= STACKED_LINE_SECONDS;
  });
}

/** The timeline with only its trusted lines; null for no timeline. */
export function trustedTimeline(
  timings: LyricTimings | null | undefined,
  opts: { estimates?: boolean } = {},
): LyricTimings | null {
  if (!timings) return null;
  const mask = trustedMask(timings, opts);
  return { ...timings, lines: timings.lines.filter((_, i) => mask[i]) };
}
