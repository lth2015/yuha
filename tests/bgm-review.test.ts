/**
 * The BGM listening review's scorer (docs/quality/BGM_REVIEW.md), checked
 * against reviews whose answer is known. A scorer nobody checked measures
 * whatever it happens to compute.
 */
import { describe, expect, it } from 'vitest';
import { agreement, calibrateVoice, parseReviews, summarize } from '../scripts/lib/bgm-review.mjs';

const header = 'trackId,reviewer,fitsBackground,fitsScenario,fitsGenre,fitsMood,soundQuality,cleanEdges,voiceHeard,usable,note';
const row = (t: string, r: string, scores: number[], voice: string, usable: string, note = '') =>
  [t, r, ...scores, voice, usable, note].join(',');

const meta = {
  a: { scenario: 'vlog', genre: 'lofi', mood: 'calm', durationSeconds: 30 },
  b: { scenario: 'travel', genre: 'jazz', mood: 'warm', durationSeconds: 15 },
  c: { scenario: 'vlog', genre: 'lofi', mood: 'warm', durationSeconds: 60 },
};

describe('reading a review sheet', () => {
  it('reads every row, quoted notes with commas included', () => {
    const rows = parseReviews([header, row('a', 'r1', [5, 4, 4, 5, 4, 5], 'no', 'yes', '"soft, nice"')].join('\n'));
    expect(rows).toEqual([
      { trackId: 'a', reviewer: 'r1', fitsBackground: 5, fitsScenario: 4, fitsGenre: 4, fitsMood: 5, soundQuality: 4, cleanEdges: 5, voiceHeard: false, usable: true, note: 'soft, nice' },
    ]);
  });

  it('refuses a score outside 1–5 or a yes/no it cannot read, rather than guess', () => {
    expect(() => parseReviews([header, row('a', 'r1', [6, 4, 4, 5, 4, 5], 'no', 'yes')].join('\n'))).toThrow(/fitsBackground/);
    expect(() => parseReviews([header, row('a', 'r1', [5, 4, 4, 5, 4, 5], 'maybe', 'yes')].join('\n'))).toThrow(/voiceHeard/);
  });

  it('refuses a sheet with no reviews', () => {
    expect(() => parseReviews(header)).toThrow(/no reviews/);
  });
});

describe('the summary', () => {
  const rows = parseReviews([
    header,
    row('a', 'r1', [5, 5, 5, 5, 5, 5], 'no', 'yes'),
    row('b', 'r1', [2, 3, 3, 3, 2, 2], 'yes', 'no'),
    row('c', 'r1', [4, 4, 4, 4, 4, 4], 'no', 'yes'),
  ].join('\n'));

  it('counts a BGM usable as-is by the reviewers’ majority, and averages each criterion', () => {
    const s = summarize(rows, meta);
    expect(s.tracks).toBe(3);
    expect(s.usable).toBeCloseTo(2 / 3);
    expect(s.voiceHeard).toBeCloseTo(1 / 3);
    expect(s.means.fitsBackground).toBeCloseTo((5 + 2 + 4) / 3);
  });

  it('breaks the usable rate down by what was chosen', () => {
    const s = summarize(rows, meta);
    expect(s.by.genre.lofi).toEqual({ tracks: 2, usable: 2 });
    expect(s.by.genre.jazz).toEqual({ tracks: 1, usable: 0 });
    expect(s.by.durationSeconds['15']).toEqual({ tracks: 1, usable: 0 });
  });
});

describe('two reviewers', () => {
  it('report how often they agree on usable and on a voice', () => {
    const rows = parseReviews([
      header,
      row('a', 'r1', [5, 5, 5, 5, 5, 5], 'no', 'yes'),
      row('a', 'r2', [5, 5, 5, 5, 5, 5], 'no', 'no'),
      row('b', 'r1', [2, 3, 3, 3, 2, 2], 'yes', 'no'),
      row('b', 'r2', [2, 3, 3, 3, 2, 2], 'yes', 'no'),
    ].join('\n'));
    expect(agreement(rows)).toEqual({ tracks: 2, usable: 0.5, voiceHeard: 1 });
  });
});

describe('calibrating the voice threshold', () => {
  // People heard a voice in v1 and v2; the separator measured these seconds.
  const rows = parseReviews([
    header,
    row('v1', 'r1', [3, 3, 3, 3, 3, 3], 'yes', 'no'),
    row('v2', 'r1', [3, 3, 3, 3, 3, 3], 'yes', 'no'),
    row('q1', 'r1', [5, 5, 5, 5, 5, 5], 'no', 'yes'),
    row('q2', 'r1', [5, 5, 5, 5, 5, 5], 'no', 'yes'),
    row('u1', 'r1', [5, 5, 5, 5, 5, 5], 'no', 'yes'),
  ].join('\n'));
  const quality = { v1: { vocalSeconds: 9 }, v2: { vocalSeconds: 3.5 }, q1: { vocalSeconds: 0 }, q2: { vocalSeconds: 2.5 }, u1: { vocalSeconds: null } };

  it('scores every threshold against what people heard, leaving out what was not measured', () => {
    const table = calibrateVoice(rows, quality, [1, 3, 5]);
    expect(table.map((t) => [t.threshold, t.tp, t.fp, t.fn, t.tn])).toEqual([
      [1, 2, 1, 0, 1],
      [3, 2, 0, 0, 2],
      [5, 1, 0, 1, 2],
    ]);
    expect(table[1]!.precision).toBe(1);
    expect(table[1]!.recall).toBe(1);
    expect(table[0]!.measured).toBe(4);
  });
});
