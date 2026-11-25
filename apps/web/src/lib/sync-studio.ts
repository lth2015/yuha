/**
 * The lyric timing workspace's rules (docs/MV_LYRIC_SYNC_UX_SPEC.md, phase 1).
 *
 * The moving itself is `setLineStart` in @yuha/contracts, the one place that
 * keeps a timeline a timeline; these are the workspace's own decisions on top:
 * a step in seconds, how far a line may go, what "listen to this line" plays,
 * which slice of the song is on screen, and an undo that walks back as far as
 * what is saved.
 */
import { MIN_LINE_SECONDS, setLineStart, type LyricTimings } from '@yuha/contracts';

type Lines = LyricTimings['lines'];
const r3 = (v: number) => Number(v.toFixed(3));

/** One line, `delta` seconds later (or earlier, negative); its neighbours stay put. */
export function moveLine(timings: LyricTimings, index: number, delta: number, duration: number): LyricTimings {
  const line = timings.lines[index];
  return line ? setLineStart(timings, index, line.start + delta, duration) : timings;
}

/** Where a line's start may go: after the line before it and before the one after, as setLineStart holds it. */
export function lineRange(lines: Lines, index: number, duration: number): { min: number; max: number } {
  const prev = lines[index - 1];
  const next = lines[index + 1];
  return {
    min: r3(prev ? prev.start + MIN_LINE_SECONDS : 0),
    max: r3(next ? next.start - MIN_LINE_SECONDS : duration - MIN_LINE_SECONDS),
  };
}

/** "Listen to this line": from two seconds before it, to a second after it ends. */
export function loopRange(lines: Lines, index: number, duration: number): { from: number; to: number } {
  const line = lines[index];
  if (!line) return { from: 0, to: duration };
  return { from: r3(Math.max(0, line.start - 2)), to: r3(Math.min(duration, line.end + 1)) };
}

/** `span` seconds of the song around `centre`, never outside it. */
export function windowAround(centre: number, span: number, duration: number): { from: number; to: number } {
  if (span >= duration) return { from: 0, to: duration };
  const from = Math.min(Math.max(0, centre - span / 2), duration - span);
  return { from: r3(from), to: r3(from + span) };
}

/**
 * Unsaved edits. `present` null is "nothing unsaved": what is on screen is
 * what is saved, so undoing the first edit lands there and Save goes away.
 */
export interface EditHistory {
  past: Array<LyricTimings | null>;
  present: LyricTimings | null;
  future: Array<LyricTimings | null>;
}
export const emptyHistory: EditHistory = { past: [], present: null, future: [] };

export function record(h: EditHistory, next: LyricTimings): EditHistory {
  return { past: [...h.past, h.present].slice(-100), present: next, future: [] };
}
export function undo(h: EditHistory): EditHistory {
  if (!h.past.length) return h;
  return { past: h.past.slice(0, -1), present: h.past[h.past.length - 1]!, future: [h.present, ...h.future] };
}
export function redo(h: EditHistory): EditHistory {
  if (!h.future.length) return h;
  return { past: [...h.past, h.present], present: h.future[0]!, future: h.future.slice(1) };
}
