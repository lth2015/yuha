/**
 * Correcting a lyric line, after the song exists.
 *
 * This is the only half of lyric timing a person can fix. The music service
 * takes no timing input — its submit request has `lyrics`, `tempo` and
 * `energy` and nothing that could say when a line is sung — so a timestamp
 * edited before generation would be a wish the generator never reads, and
 * offering one would be the same lie as a percentage on a three-state
 * control. Afterwards the audio is fixed and a late line is a fact.
 *
 * The rules are tested rather than eyeballed because what drives them is a
 * drag and a keypress, neither of which the suite can reach. What it can
 * reach is the guarantee underneath: whatever a person does, the result is
 * still a timeline — in order, non-overlapping, inside the song.
 *
 * No database: pure functions.
 */
import { describe, expect, it } from 'vitest';
import { MIN_LINE_SECONDS, markCorrected, setLineStart, shiftTimings, type LyricTimings } from '@yuha/contracts';

const DURATION = 60;

const timings = (over: Partial<LyricTimings> = {}): LyricTimings => ({
  source: 'estimated',
  aligner: 'estimated-v1',
  lines: [
    { text: 'one', section: 'verse', start: 3, end: 8 },
    { text: 'two', section: 'verse', start: 8, end: 13 },
    { text: 'three', section: 'chorus', start: 13, end: 18 },
  ],
  ...over,
});

const starts = (t: LyricTimings) => t.lines.map((l) => l.start);

describe('shifting the whole song', () => {
  it('moves every line by the same amount', () => {
    expect(starts(shiftTimings(timings(), 2.5, DURATION))).toEqual([5.5, 10.5, 15.5]);
  });

  it('is the fix for the common failure, and reverses exactly', () => {
    // A song uniformly late because the intro ran long. One number, and
    // undoing it has to land back where it started or the control is a trap.
    const out = shiftTimings(shiftTimings(timings(), 2.5, DURATION), -2.5, DURATION);
    expect(starts(out)).toEqual([3, 8, 13]);
  });

  it('never moves a line before the song starts or past its end', () => {
    expect(starts(shiftTimings(timings(), -100, DURATION))).toEqual([0, 0, 0]);
    for (const line of shiftTimings(timings(), 100, DURATION).lines) {
      expect(line.end).toBeLessThanOrEqual(DURATION);
    }
  });

  it('carries word timings along, because they are as late as their line', () => {
    const withWords = timings({
      lines: [{ text: 'one', section: '', start: 3, end: 8, words: [{ w: 'one', start: 3, end: 4 }] }],
    });
    expect(shiftTimings(withWords, 1, DURATION).lines[0]!.words).toEqual([{ w: 'one', start: 4, end: 5 }]);
  });
});

describe('moving one line', () => {
  it('moves that line and leaves its neighbours where they were', () => {
    // Tapping along corrects one line at a time; dragging the neighbours
    // would undo the taps already made.
    const out = setLineStart(timings(), 1, 9.5, DURATION);
    expect(starts(out)).toEqual([3, 9.5, 13]);
  });

  it('closes the gap it opens, so two lines are never lit at once', () => {
    const out = setLineStart(timings(), 1, 9.5, DURATION);
    expect(out.lines[0]!.end).toBe(9.5);
  });

  it('will not let a line overtake the one before it', () => {
    const out = setLineStart(timings(), 1, 0, DURATION);
    expect(out.lines[1]!.start).toBe(3 + MIN_LINE_SECONDS);
    expect(out.lines[1]!.start).toBeGreaterThan(out.lines[0]!.start);
  });

  it('will not let a line overtake the one after it', () => {
    const out = setLineStart(timings(), 1, 999, DURATION);
    expect(out.lines[1]!.start).toBe(13 - MIN_LINE_SECONDS);
    expect(out.lines[1]!.start).toBeLessThan(out.lines[2]!.start);
  });

  it('keeps the last line inside the song', () => {
    const out = setLineStart(timings(), 2, 999, DURATION);
    expect(out.lines[2]!.start).toBeLessThanOrEqual(DURATION - MIN_LINE_SECONDS);
    expect(out.lines[2]!.end).toBeLessThanOrEqual(DURATION);
  });

  it('leaves a timeline alone when there is no room to move in', () => {
    const tight = timings({
      lines: [
        { text: 'a', section: '', start: 1, end: 1.2 },
        { text: 'b', section: '', start: 1.2, end: 1.4 },
        { text: 'c', section: '', start: 1.4, end: 1.6 },
      ],
    });
    expect(setLineStart(tight, 1, 5, DURATION)).toEqual(tight);
  });

  it('ignores an index that is not there', () => {
    expect(setLineStart(timings(), 9, 5, DURATION)).toEqual(timings());
  });

  it('keeps the lines in order whatever is thrown at it', () => {
    let t = timings();
    for (const [i, at] of [[1, 99], [0, 50], [2, -4], [1, 0], [2, 7]] as const) {
      t = setLineStart(t, i, at, DURATION);
      for (let k = 1; k < t.lines.length; k += 1) {
        expect(t.lines[k]!.start).toBeGreaterThan(t.lines[k - 1]!.start);
      }
    }
  });
});

describe('what a corrected timeline says about itself', () => {
  it('names a person, which is what stops a re-alignment overwriting it', () => {
    const out = markCorrected(timings());
    expect(out.source).toBe('corrected');
    expect(out.aligner).toBe('human');
  });

  it('keeps the lines exactly as they were', () => {
    expect(markCorrected(timings()).lines).toEqual(timings().lines);
  });
});
