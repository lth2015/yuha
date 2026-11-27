/**
 * One rule for which lyric lines may be lit, burned into a video or written
 * to an .lrc (docs/agents/LYRIC_AUTO_SYNC_UX_HANDOFF.md, "可信时间轴的共同规则").
 *
 * A person's correction is trusted; a line the aligner heard is trusted unless
 * it said it was unsure; an estimate is for reading, never for timing — under
 * the strict rule. Every consumer asks the same function, so the player, the
 * videos and the .lrc cannot disagree about a line.
 */
import { describe, expect, it } from 'vitest';
import { isTrustedLine, trustedMask, trustedTimeline, type LyricTimings } from '@yuha/contracts';
import { buildAss, subtitleLines } from '@yuha/worker/scene-mv-compose';
import { activeLineIndex, activeTrustedLine, timedLinesFor, trustedFlags } from '../apps/web/src/lib/lyrics';
import { planShareClip } from '../apps/web/src/lib/share-art';

const lines = [
  { text: 'one', section: 'Verse', start: 2, end: 4 },
  { text: 'two', section: 'Verse', start: 6, end: 8 },
  { text: 'three', section: 'Chorus', start: 12, end: 15 },
];
const aligned = (conf: (number | undefined)[]): LyricTimings => ({
  source: 'aligned',
  aligner: 'mms-fa',
  lines: lines.map((l, i) => (conf[i] === undefined ? l : { ...l, confidence: conf[i] })),
});
const estimated: LyricTimings = { source: 'estimated', aligner: 'estimated-v1', lines };
const corrected: LyricTimings = { source: 'corrected', aligner: 'human', lines };

describe('which lines are trusted', () => {
  it('a correction’s every line; a heard line unless the aligner was unsure; an estimate’s none, strictly', () => {
    expect(corrected.lines.map((l) => isTrustedLine(corrected, l))).toEqual([true, true, true]);
    const a = aligned([1, 0.2, undefined]);
    expect(a.lines.map((l) => isTrustedLine(a, l))).toEqual([true, false, true]);
    expect(estimated.lines.map((l) => isTrustedLine(estimated, l))).toEqual([false, false, false]);
    // The rule as it was, for those not yet on the strict one.
    expect(estimated.lines.map((l) => isTrustedLine(estimated, l, { estimates: true }))).toEqual([true, true, true]);
  });

  it('gives the trusted lines only, and nothing for no timeline', () => {
    expect(trustedTimeline(aligned([1, 0.2, 1]))?.lines.map((l) => l.text)).toEqual(['one', 'three']);
    expect(trustedTimeline(estimated)?.lines).toEqual([]);
    expect(trustedTimeline(null)).toBeNull();
  });
});

describe('lines piled onto one instant (production, 2026-11-27)', () => {
  // An aligner out of voice stacked the rest of a song at 93.5 s, each "sure".
  const piled: LyricTimings = {
    source: 'aligned',
    lines: [
      { section: '', text: 'a', start: 80, end: 93.3, confidence: 1 },
      { section: '', text: 'b', start: 93.36, end: 93.96, confidence: 1 },
      { section: '', text: 'c', start: 93.52, end: 94.12, confidence: 1 },
      { section: '', text: 'd', start: 93.52, end: 94.12, confidence: 1 },
      { section: '', text: 'e', start: 93.52, end: 94.12, confidence: 1 },
      { section: '', text: 'f', start: 97, end: 99, confidence: 1 },
    ],
  };

  it('lights none of the stacked lines, and the rest as before', () => {
    expect(trustedMask(piled)).toEqual([true, true, true, false, false, true]);
    expect(trustedFlags(piled, true)).toEqual([true, true, true, false, false, true]);
    expect(trustedTimeline(piled)!.lines.map((l) => l.text)).toEqual(['a', 'b', 'c', 'f']);
  });

  it('leaves a person’s timeline alone, stacked or not', () => {
    expect(trustedMask({ ...piled, source: 'corrected' })).toEqual([true, true, true, true, true, true]);
  });
});

describe('the highlight', () => {
  it('lights a trusted line only while it is sung, and does not stretch the line before over a gap', () => {
    const a = aligned([1, 0.2, 1]);
    const flags = a.lines.map((l) => isTrustedLine(a, l));
    expect(activeTrustedLine(a.lines, flags, 3)).toBe(0);
    expect(activeTrustedLine(a.lines, flags, 5)).toBe(-1); // between lines: nothing, not "one" held over
    expect(activeTrustedLine(a.lines, flags, 7)).toBe(-1); // "two" is unsure: not lit
    expect(activeTrustedLine(a.lines, flags, 13)).toBe(2);
    // The old rule held the previous line over the gap.
    expect(activeLineIndex(a.lines, 5)).toBe(0);
  });
});

describe('the videos and the .lrc', () => {
  it('draw and write only trusted lines; an estimate gives a video without words', () => {
    const a = aligned([1, 0.2, 1]);
    const text = (l: { line: string | null }) => l.line;
    const plan = planShareClip(timedLinesFor(a, true), 30, 50, 30);
    expect(plan.frames.map(text).filter(Boolean)).toEqual(['one', 'three']);
    expect(planShareClip(timedLinesFor(estimated, true), 30, 50, 30).frames.map(text).filter(Boolean)).toEqual([]);
    expect(planShareClip(timedLinesFor(estimated, false), 30, 50, 30).frames.map(text).filter(Boolean)).toEqual(['one', 'two', 'three']);
  });

  it('take a line off the share video when it ends, so a gap or an unsure line shows nothing (Codex, PR #157)', () => {
    // Trusted 2-4 s, unsure 6-8 s, trusted 12-15 s.
    const t = aligned([1, 0.2, 1]);
    t.lines[2] = { ...t.lines[2]!, start: 12, end: 15 };
    const plan = planShareClip(timedLinesFor(t, true), 30, 50, 30);
    const at = (songSeconds: number) => {
      let shown: string | null = null;
      for (const f of plan.frames) if (plan.start + f.at <= songSeconds) shown = f.line;
      return shown;
    };
    expect(at(3)).toBe('one');
    expect(at(5)).toBeNull(); // the gap after it
    expect(at(7)).toBeNull(); // the unsure line is not shown, and 'one' is not held over it
    expect(at(13)).toBe('three');
    expect(at(16)).toBeNull();
  });

  it('burn only trusted lines into the scene MV', () => {
    const ass = buildAss(subtitleLines(aligned([1, 0.2, 1])), 0, 30);
    const said = ass.split('\n').filter((l) => l.startsWith('Dialogue:')).map((l) => l.split(',').slice(9).join(','));
    expect(said).toEqual(['one', 'three']);
    expect(subtitleLines(estimated)).toEqual([]);
    expect(subtitleLines(null)).toEqual([]);
  });
});
