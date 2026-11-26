/**
 * The lyric sync benchmark's scorer, checked against annotations whose answer
 * is known (docs/quality/LYRIC_BENCH.md). A scorer nobody checked measures
 * whatever it happens to compute.
 */
import { describe, expect, it } from 'vitest';
import { annotatorFloor, compareRoutes, scoreSong, summarize } from '../scripts/lib/lyric-bench.mjs';

const truth = (id: string, language: string, starts: (number | null)[]) => ({
  songId: id,
  language,
  lines: starts.map((start, idx) => ({ idx, sung: start !== null, start })),
});
const pred = (starts: number[], confidence?: (number | undefined)[]) => ({
  source: 'aligned',
  lines: starts.map((start, i) => ({ text: `l${i}`, section: '', start, end: start + 1, ...(confidence?.[i] !== undefined ? { confidence: confidence[i] } : {}) })),
});

describe('scoring one song', () => {
  it('counts a sung line as hit within the tolerance, and an unsung one that lights up as a false highlight', () => {
    const rows = scoreSong(truth('a', 'zh', [1.0, 5.0, null, 12.0]), pred([1.2, 5.6, 9.0, 12.0]));
    expect(rows.map((r) => r.hit)).toEqual([true, false, null, true]);
    expect(rows.map((r) => r.falseHighlight)).toEqual([false, false, true, false]);
    expect(rows[1]!.error).toBeCloseTo(0.6);
  });

  it('treats a line the aligner marked unconfirmed as honestly withheld, not as hit and not as a false highlight', () => {
    const rows = scoreSong(truth('a', 'ja', [1.0, null]), pred([3.0, 9.0], [0.2, 0.1]));
    expect(rows.map((r) => [r.hit, r.unconfirmed, r.falseHighlight])).toEqual([
      [false, true, false],
      [null, true, false],
    ]);
  });

  it('refuses a prediction whose lines are not the song’s lines', () => {
    expect(() => scoreSong(truth('a', 'en', [1, 2]), pred([1]))).toThrow(/line count/);
  });
});

describe('the summary', () => {
  it('reports per language, and a song is usable only with every sung line hit and nothing falsely lit', () => {
    const rows = [
      ...scoreSong(truth('a', 'zh', [1, 5]), pred([1, 5])),
      ...scoreSong(truth('b', 'zh', [1, null]), pred([1, 7])),
      ...scoreSong(truth('c', 'en', [1, 5]), pred([1, 9])),
    ];
    const s = summarize(rows, { seed: 1 });
    expect(s.all.songs).toBe(3);
    expect(s.all.usableSongs).toBe(1);
    expect(s.byLanguage.zh.hitRate).toBeCloseTo(3 / 3);
    expect(s.byLanguage.zh.falseHighlightRate).toBeCloseTo(1 / 1);
    expect(s.byLanguage.en.hitRate).toBeCloseTo(1 / 2);
    expect(s.all.hitRateCi[0]).toBeLessThanOrEqual(s.all.hitRate);
    expect(s.all.hitRateCi[1]).toBeGreaterThanOrEqual(s.all.hitRate);
  });

  it('is the same every run with the same seed', () => {
    const rows = [...scoreSong(truth('a', 'zh', [1, 5, 9]), pred([1, 6, 9])), ...scoreSong(truth('b', 'zh', [1, 5]), pred([1.1, 5]))];
    expect(summarize(rows, { seed: 7 })).toEqual(summarize(rows, { seed: 7 }));
  });
});

describe('the noise floor between two annotators', () => {
  it('is the median and P90 of their start differences on lines both heard sung', () => {
    const a = truth('a', 'zh', [1.0, 5.0, 9.0, null, 20.0]);
    const b = truth('a', 'zh', [1.1, 5.0, 9.4, 15.0, 20.2]);
    const floor = annotatorFloor([a], [b]);
    expect(floor.lines).toBe(4);
    expect(floor.median).toBeCloseTo(0.15);
    expect(floor.p90).toBeCloseTo(0.4);
    expect(floor.sungDisagreements).toBe(1);
  });
});

describe('comparing two routes on the same lines', () => {
  const songs = ['a', 'b', 'c', 'd'].map((id) => truth(id, 'zh', [1, 5, 9, 13]));

  it('says they differ only when the paired interval excludes zero', () => {
    const base = songs.flatMap((t) => scoreSong(t, pred([1, 6, 10, 14])));
    const better = songs.flatMap((t) => scoreSong(t, pred([1, 5, 9, 13])));
    const c = compareRoutes(base, better, { seed: 3 });
    expect(c.hitRateDiff).toBeCloseTo(0.75);
    expect(c.ci[0]).toBeGreaterThan(0);
    expect(c.verdict).toBe('better');

    const same = compareRoutes(base, base, { seed: 3 });
    expect(same.verdict).toBe('no_difference');
  });

  it('rejects a route that lights up more unsung lines, however many it hits', () => {
    const withGap = songs.map((t) => ({ ...t, lines: t.lines.map((l, i) => (i === 3 ? { ...l, sung: false, start: null } : l)) }));
    const base = withGap.flatMap((t) => scoreSong(t, pred([1, 6, 10, 14], [1, 1, 1, 0.1])));
    const hitsMoreButLights = withGap.flatMap((t) => scoreSong(t, pred([1, 5, 9, 13])));
    expect(compareRoutes(base, hitsMoreButLights, { seed: 3 }).verdict).toBe('rejected_false_highlight');
  });
});
