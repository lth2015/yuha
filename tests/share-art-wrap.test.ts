/**
 * Line breaking on the share card (apps/web/src/lib/share-art.ts). A card is
 * read in a feed in a second; a line that starts with "。" reads as a mistake.
 */
import { describe, expect, it } from 'vitest';
import { wrapText } from '../apps/web/src/lib/share-art.js';

// Every character is 10 wide, so widths are character counts × 10.
const mono = { measureText: (s: string) => ({ width: [...s].length * 10 }) as TextMetrics };

describe('wrapText', () => {
  it('breaks Chinese between characters, never starting a line with closing punctuation', () => {
    // 7 wide: the "。" that would open line two hangs on line one instead.
    expect(wrapText(mono, '让心动，有回声。', 70, 3)).toEqual(['让心动，有回声。']);
    expect(wrapText(mono, '让心动，有回声。', 60, 3)).toEqual(['让心动，有回', '声。']);
    expect(wrapText(mono, '写下一段心情，做成属于这一刻的音乐。', 70, 3).every((l) => !/^[，。]/.test(l))).toBe(true);
  });

  it('breaks English between words', () => {
    expect(wrapText(mono, 'A song for Mika', 90, 3)).toEqual(['A song', 'for Mika']);
  });

  it('cuts what does not fit with an ellipsis, inside the width', () => {
    const lines = wrapText(mono, '一二三四五六七八九十一二三四五', 50, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.endsWith('…')).toBe(true);
    expect([...lines[1]!].length * 10).toBeLessThanOrEqual(50);
  });
});

import { planShareClip } from '../apps/web/src/lib/share-art.js';

describe('planShareClip', () => {
  const lines = [
    { text: 'one', section: 'Verse', start: 10, end: 14 },
    { text: 'two', section: 'Verse', start: 14, end: 18 },
    { text: 'chorus a', section: 'Chorus', start: 40, end: 44 },
    { text: 'chorus b', section: 'Chorus', start: 44, end: 48 },
    { text: 'after', section: 'Verse', start: 70, end: 74 },
  ];

  it('opens on the chorus, a breath before it, for twenty seconds', () => {
    const plan = planShareClip(lines, 120);
    expect(plan.start).toBe(38.5);
    expect(plan.duration).toBe(20);
    expect(plan.frames).toEqual([
      { at: 0, line: null },
      { at: 1.5, line: 'chorus a' },
      { at: 5.5, line: 'chorus b' },
    ]);
  });

  it('starts at the first sung line when no chorus is marked, with the line already on screen if it is mid-way', () => {
    const plain = lines.map((l) => ({ ...l, section: 'Verse' }));
    expect(planShareClip(plain, 120).start).toBe(8.5);
    const mid = planShareClip([{ text: 'held', section: '', start: 0, end: 30 }], 60);
    expect(mid.frames[0]).toEqual({ at: 0, line: 'held' });
  });

  it('stays inside a short song, and takes an instrumental from past its intro', () => {
    const short = planShareClip([{ text: 'x', section: 'Chorus', start: 25, end: 28 }], 30);
    expect(short.start + short.duration).toBeLessThanOrEqual(30);
    const inst = planShareClip([], 120);
    expect(inst.start).toBe(30);
    expect(inst.frames).toEqual([{ at: 0, line: null }]);
  });
});
