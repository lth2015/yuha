/**
 * Moving a lyric line in time, after the song exists.
 *
 * This is the half of lyric timing that a person can actually fix. Before the
 * audio is generated there is nothing to correct against — the music service
 * takes no timing input at all (its SubmitRequest has `lyrics`, `tempo` and
 * `energy`, and no field that could say when a line is sung), so a timestamp
 * edited before generation would be a wish the generator never reads.
 * Afterwards the audio is fixed, and a line that lands late is a fact anyone
 * can hear and nobody currently has a way to repair.
 *
 * The rules below exist because a timeline a person has edited still has to
 * be a timeline: lines in order, none on top of another, nothing past the end
 * of the song. They are pure so they can be tested, which matters more than
 * usual here — the thing driving them is a drag and a keypress, and neither
 * is reachable from the suite.
 */
import type { LyricTimings } from './generation.js';

/** No line may be squeezed shorter than this, so a nudge cannot erase one. */
export const MIN_LINE_SECONDS = 0.3;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
/** Milliseconds are the finest unit anyone can hear; thousandths keep JSON small. */
const round = (v: number) => Number(v.toFixed(3));

/**
 * Moves every line by the same amount.
 *
 * The common failure by far: the whole song is uniformly late because the
 * intro ran longer than the estimate assumed. One number fixes all of it, and
 * it is the only correction most songs will ever need.
 */
export function shiftTimings(timings: LyricTimings, seconds: number, durationSeconds: number): LyricTimings {
  const move = (v: number) => round(clamp(v + seconds, 0, durationSeconds));
  return {
    ...timings,
    lines: timings.lines.map((line) => ({
      ...line,
      start: move(line.start),
      end: move(line.end),
      ...(line.words ? { words: line.words.map((w) => ({ ...w, start: move(w.start), end: move(w.end) })) } : {}),
    })),
  };
}

/**
 * Moves one line to a given moment, and only that line.
 *
 * Deliberately local: tapping along to a song corrects one line at a time, and
 * a correction that dragged its neighbours would undo the taps already made.
 * The line is held between the one before and the one after, so the order a
 * listener hears can never disagree with the order on screen. Its words move
 * with it — they describe this line's own syllables, so they are as late as
 * it is.
 */
export function setLineStart(
  timings: LyricTimings,
  index: number,
  start: number,
  durationSeconds: number,
): LyricTimings {
  const line = timings.lines[index];
  if (!line) return timings;

  const prev = timings.lines[index - 1];
  const next = timings.lines[index + 1];
  const floor = prev ? prev.start + MIN_LINE_SECONDS : 0;
  const ceiling = next ? next.start - MIN_LINE_SECONDS : durationSeconds - MIN_LINE_SECONDS;
  // A song too short to hold the line between its neighbours keeps it where it
  // is rather than inverting the order.
  if (ceiling < floor) return timings;

  const nextStart = round(clamp(start, floor, ceiling));
  const delta = nextStart - line.start;
  const lines = timings.lines.slice();
  lines[index] = {
    ...line,
    start: nextStart,
    end: round(clamp(Math.max(line.end + delta, nextStart + MIN_LINE_SECONDS), 0, durationSeconds)),
    ...(line.words
      ? {
          words: line.words.map((w) => ({
            ...w,
            start: round(clamp(w.start + delta, 0, durationSeconds)),
            end: round(clamp(w.end + delta, 0, durationSeconds)),
          })),
        }
      : {}),
  };

  // The previous line ends where this one begins; leaving it long would light
  // two lines at once.
  if (prev) lines[index - 1] = { ...prev, end: round(Math.max(prev.start + MIN_LINE_SECONDS, nextStart)) };
  return { ...timings, lines };
}

/**
 * Marks a timeline as a person's work.
 *
 * `aligner` records who to credit, and it is what tells a later re-alignment
 * to leave this alone: a model's second opinion does not outrank somebody who
 * sat and listened.
 */
export function markCorrected(timings: LyricTimings): LyricTimings {
  return { ...timings, source: 'corrected', aligner: 'human' };
}
