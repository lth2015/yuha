/**
 * The moderator's numbers for the usability test (#35).
 *
 * A stopwatch in one hand and notes in the other is how exploration time gets
 * misrecorded. With #observe, the page counts what happened on this load and
 * shows it to the moderator only: nothing is stored or sent, and closing the
 * tab forgets it. These tests pin what each number means, because the report
 * compares them against fixed pass lines.
 *
 * No database: a pure reducer.
 */
import { describe, expect, it } from 'vitest';
import { createObservation } from '../apps/air/src/play/observe.js';

describe('observation of one page load', () => {
  it('starts empty, counting from when the page was shown', () => {
    const o = createObservation(1000);
    expect(o.summary()).toEqual({
      msToFirstTouch: null,
      performances: 0,
      tooShort: 0,
      playedMs: 0,
      replays: 0,
      toSongAtMs: null,
      shares: 0,
    });
  });

  it('measures the wait before the first touch, once', () => {
    const o = createObservation(1000);
    o.touch(3500);
    o.touch(9000);
    expect(o.summary().msToFirstTouch).toBe(2500);
  });

  it('adds up the length of every performance that ended, auto or by 「完成」', () => {
    const o = createObservation(0);
    o.performanceEnded(30_000);
    o.performanceEnded(12_400);
    expect(o.summary()).toMatchObject({ performances: 2, playedMs: 42_400 });
  });

  it('counts a too-short take apart, but still counts the time spent playing it', () => {
    const o = createObservation(0);
    o.tooShort(3_200);
    expect(o.summary()).toMatchObject({ performances: 0, tooShort: 1, playedMs: 3_200 });
  });

  it('records when 「让它成为一首歌」 was first tapped, since the page was shown', () => {
    const o = createObservation(2000);
    o.toSong(50_000);
    o.toSong(80_000);
    expect(o.summary().toSongAtMs).toBe(48_000);
  });

  it('counts replays and shared links', () => {
    const o = createObservation(0);
    o.replay();
    o.replay();
    o.share();
    expect(o.summary()).toMatchObject({ replays: 2, shares: 1 });
  });

  it('says it in one line the moderator can copy into the sheet', () => {
    const o = createObservation(0);
    o.touch(1800);
    o.performanceEnded(30_000);
    o.performanceEnded(21_000);
    o.replay();
    o.toSong(70_000);
    expect(o.line()).toBe('first touch 1.8 s · played 51.0 s in 2 performance(s) (+0 too short) · replays 1 · make-it-a-song at 70.0 s · shares 0');
  });
});
