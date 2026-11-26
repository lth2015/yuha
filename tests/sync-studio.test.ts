/**
 * The lyric timing workspace's rules (docs/MV_LYRIC_SYNC_UX_SPEC.md, phase 1),
 * pure so they can be held to: one line moves without dragging the others,
 * undo and redo walk the edits, the loop is the line with a little either
 * side.
 */
import { describe, expect, it } from 'vitest';
import type { LyricTimings } from '@yuha/contracts';
import {
  emptyHistory,
  lineRange,
  loopRange,
  moveLine,
  record,
  redo,
  undo,
} from '../apps/web/src/lib/sync-studio.js';

const timings = (starts: number[]): LyricTimings => ({
  source: 'estimated',
  lines: starts.map((s, i) => ({ text: `line ${i}`, start: s, end: (starts[i + 1] ?? s + 3) - 0.1 })),
});

describe('moving one line', () => {
  it('moves the chosen line by the step and leaves the others where they were', () => {
    const t = moveLine(timings([2, 6, 10]), 1, 0.1, 30);
    expect(t.lines.map((l) => l.start)).toEqual([2, 6.1, 10]);
  });
  it('stops at its neighbours rather than passing them', () => {
    const t = moveLine(timings([2, 6, 10]), 1, 9, 30);
    expect(t.lines[1]!.start).toBe(9.7);
    expect(t.lines[2]!.start).toBe(10);
  });
  it('says how far a line can go, so the page can show it', () => {
    expect(lineRange(timings([2, 6, 10]).lines, 1, 30)).toEqual({ min: 2.3, max: 9.7 });
    expect(lineRange(timings([2, 6, 10]).lines, 0, 30)).toEqual({ min: 0, max: 5.7 });
    expect(lineRange(timings([2, 6, 10]).lines, 2, 30)).toEqual({ min: 6.3, max: 29.7 });
  });
});

describe('undo and redo', () => {
  it('walks back to the saved timings and forward again; a new edit drops what was undone', () => {
    const a = timings([1]);
    const b = timings([2]);
    const c = timings([3]);
    let h = record(record(emptyHistory, a), b);
    expect(h.present).toBe(b);
    h = undo(h);
    expect(h.present).toBe(a);
    h = undo(h);
    expect(h.present).toBeNull(); // nothing unsaved: what is shown is what is saved
    expect(undo(h)).toBe(h);
    h = redo(h);
    expect(h.present).toBe(a);
    h = record(h, c);
    expect(h.present).toBe(c);
    expect(redo(h)).toBe(h);
  });
});

describe('listening to one line', () => {
  it('starts two seconds before it and ends one second after, inside the song', () => {
    const lines = timings([1, 6, 10]).lines;
    expect(loopRange(lines, 1, 30)).toEqual({ from: 4, to: 10.9 });
    expect(loopRange(lines, 0, 30)).toEqual({ from: 0, to: 6.9 });
    expect(loopRange(timings([28]).lines, 0, 30)).toEqual({ from: 26, to: 30 });
  });
});
