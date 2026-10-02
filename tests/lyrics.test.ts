/**
 * The synced-lyrics timing engine: deterministic, monotone, full-coverage.
 * These are the properties the karaoke display depends on.
 */
import { describe, expect, it } from 'vitest';
import { activeLineIndex, buildLyricTimeline, lineProgress } from '../apps/web/src/lib/lyrics.js';

const LYRICS = `[Verse]
City lights blur into gold
I drive until the morning breaks
[Chorus]
We are electric, we are alive`;

describe('buildLyricTimeline', () => {
  it('lays every line on a monotone axis that fits the song', () => {
    const { lines } = buildLyricTimeline(LYRICS, 120);
    expect(lines).toHaveLength(3);

    let prevEnd = -1;
    for (const line of lines) {
      expect(line.start).toBeGreaterThanOrEqual(prevEnd);
      expect(line.end).toBeGreaterThan(line.start);
      prevEnd = line.end;
    }
    // The last line ends at the tail of the song, not after it.
    expect(prevEnd).toBeLessThanOrEqual(120);
    expect(prevEnd).toBeGreaterThan(100);
  });

  /*
   * The axis used to be gap-free everywhere, including across a section
   * change, because the "section pause" was added to the first line's own
   * span instead of inserted before it. So the lyrics walked straight through
   * the instrumental between a verse and a chorus, and that line was held on
   * screen longer than it was sung — which puts the highlight behind the
   * voice from there on, cumulatively.
   */
  it('leaves silence at a section boundary, and only there', () => {
    const { lines } = buildLyricTimeline(LYRICS, 120);

    // Inside the verse: one line hands straight over to the next.
    expect(lines[1]!.start).toBeCloseTo(lines[0]!.end, 6);

    // Verse → Chorus: a real gap, with no line claiming it.
    const gap = lines[2]!.start - lines[1]!.end;
    expect(gap).toBeGreaterThan(1);
    const midGap = (lines[1]!.end + lines[2]!.start) / 2;
    expect(activeLineIndex(lines, midGap)).toBe(1);
    expect(lineProgress(lines, 1, midGap)).toBe(1);
  });

  it('keeps the gaps inside the song rather than pushing past the end', () => {
    // Many sections, little room: the gaps must come out of the sung time,
    // not be added on top of a timeline that already fills the song.
    const many = ['[Verse]', 'a', '[Chorus]', 'b', '[Verse]', 'c', '[Chorus]', 'd'].join('\n');
    const { lines } = buildLyricTimeline(many, 30);
    expect(lines).toHaveLength(4);
    expect(lines[3]!.end).toBeLessThanOrEqual(30);
    for (let i = 1; i < lines.length; i += 1) {
      expect(lines[i]!.start).toBeGreaterThanOrEqual(lines[i - 1]!.end);
    }
  });

  it('marks section labels and gives longer lines more time', () => {
    const { lines, sections } = buildLyricTimeline(LYRICS, 120);
    expect(sections).toEqual(['Verse', 'Chorus']);
    expect(lines[0]!.section).toBe('Verse');
    expect(lines[2]!.section).toBe('Chorus');

    // Line 2 is clearly longer than line 1 and must get a longer window.
    const short = lines[0]!.end - lines[0]!.start;
    const long = lines[1]!.end - lines[1]!.start;
    expect(long).toBeGreaterThan(short);
  });

  it('respects lead-in: nothing sings in the first seconds', () => {
    const { lines } = buildLyricTimeline(LYRICS, 60);
    expect(lines[0]!.start).toBeGreaterThan(0);
  });

  it('returns empty for lyric-less songs (instrumentals)', () => {
    expect(buildLyricTimeline('', 120).lines).toHaveLength(0);
    expect(buildLyricTimeline('[Instrumental]', 120).lines).toHaveLength(0);
  });
});

describe('activeLineIndex / lineProgress', () => {
  const { lines } = buildLyricTimeline(LYRICS, 120);

  it('walks lines in order as time advances', () => {
    expect(activeLineIndex(lines, -1)).toBe(-1);
    expect(activeLineIndex(lines, lines[0]!.start + 0.01)).toBe(0);
    expect(activeLineIndex(lines, lines[1]!.start + 0.01)).toBe(1);
    expect(activeLineIndex(lines, 119)).toBe(lines.length - 1);
  });

  it('progress fills the active line from 0 to 1', () => {
    const i = 0;
    expect(lineProgress(lines, i, lines[i]!.start)).toBeCloseTo(0);
    expect(lineProgress(lines, i, (lines[i]!.start + lines[i]!.end) / 2)).toBeCloseTo(0.5);
    expect(lineProgress(lines, i, lines[i]!.end)).toBeCloseTo(1);
  });
});

describe('lineProgress with aligned words', () => {
  /*
   * An aligned line carries per-character timing. A singer holds some
   * syllables and rushes others, so the fill has to follow the characters,
   * not slide linearly across the line's span.
   */
  const line = {
    section: 'verse',
    text: 'あいうえ',
    start: 10,
    end: 20,
    words: [
      { w: 'あ', start: 10, end: 11 },
      { w: 'い', start: 11, end: 12 },
      { w: 'う', start: 12, end: 18 }, // held
      { w: 'え', start: 18, end: 20 },
    ],
  };
  it('fills by sung characters, not by elapsed time', () => {
    expect(lineProgress([line], 0, 12)).toBeCloseTo(0.5); // two of four sung
    expect(lineProgress([line], 0, 15)).toBeCloseTo(0.625); // halfway through the held one
    expect(lineProgress([line], 0, 20)).toBeCloseTo(1);
  });
  it('falls back to time when the line has no words', () => {
    expect(lineProgress([{ ...line, words: undefined }], 0, 15)).toBeCloseTo(0.5);
  });
});
