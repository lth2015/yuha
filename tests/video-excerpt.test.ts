/**
 * The excerpt a song video is made from (docs/VIDEO_PLAN 2026-11-28, §一):
 * one choice, heard before it is made, used by the photo and the cover video
 * alike, so what was auditioned is what the MP4 carries.
 */
import { describe, expect, it } from 'vitest';
import { excerptLabel, nudgeExcerpt, recommendExcerpt, resizeExcerpt, SHARE_SECONDS } from '../apps/web/src/lib/excerpt.js';
import { planPhotoClip, planShareClip, type TimedLine } from '../apps/web/src/lib/share-art.js';

const line = (section: string, start: number, end: number, text = section): TimedLine => ({ section, start, end, text });
const SONG = [line('verse', 12, 16), line('verse', 16, 20), line('chorus', 41, 45, 'hook'), line('chorus', 45, 49), line('verse', 60, 64), line('chorus', 90, 94)];

describe('recommending an excerpt', () => {
  it('starts a breath before the first trusted chorus', () => {
    expect(recommendExcerpt(SONG, 120, SHARE_SECONDS)).toEqual({ start: 39.5, duration: 30, why: 'chorus' });
  });

  it('takes a playable middle when there is no trusted chorus (an instrumental, or unsure lines)', () => {
    const ex = recommendExcerpt([], 120, 30);
    expect(ex.why).toBe('middle');
    expect(ex.start + ex.duration / 2).toBeCloseTo(120 * 0.45, 1);
    expect(recommendExcerpt([line('verse', 10, 14)], 120, 30).why).toBe('middle');
  });

  it('a start the person confirmed before wins, kept inside the song', () => {
    expect(recommendExcerpt(SONG, 120, 30, 70)).toEqual({ start: 70, duration: 30, why: 'saved' });
    expect(recommendExcerpt(SONG, 120, 30, 110)).toEqual({ start: 90, duration: 30, why: 'saved' });
    expect(recommendExcerpt(SONG, 120, 30, Number.NaN).why).toBe('chorus');
  });

  it('moves back rather than running past the end, and never asks for more than the song', () => {
    const late = [line('chorus', 110, 114)];
    expect(recommendExcerpt(late, 120, 30)).toMatchObject({ start: 90, duration: 30 });
    expect(recommendExcerpt(SONG, 20, 30)).toMatchObject({ start: 0, duration: 20 });
  });
});

describe('moving it', () => {
  it('nudges by seconds inside the song, and says where it is in minutes', () => {
    const ex = recommendExcerpt(SONG, 120, 30);
    expect(nudgeExcerpt(ex, 5, 120)).toMatchObject({ start: 44.5, why: 'chosen' });
    expect(nudgeExcerpt(ex, -60, 120).start).toBe(0);
    expect(nudgeExcerpt(ex, 200, 120).start).toBe(90);
    expect(excerptLabel({ start: 39.5, duration: 30, why: 'chorus' })).toBe('0:39–1:09');
  });
});

describe('changing the length', () => {
  it('a chosen-for-you excerpt is chosen again; one the person moved keeps its start', () => {
    const auto = recommendExcerpt(SONG, 120, 30);
    expect(resizeExcerpt(auto, 60, 120, SONG)).toEqual(recommendExcerpt(SONG, 120, 60));
    const moved = nudgeExcerpt(auto, 10, 120);
    expect(resizeExcerpt(moved, 60, 120, SONG)).toEqual({ start: 49.5, duration: 60, why: 'chosen' });
    // The whole song starts at the start.
    expect(resizeExcerpt(moved, 120, 120, SONG)).toMatchObject({ start: 0, duration: 120 });
  });
});

describe('the video is the excerpt', () => {
  it('the photo and the cover video both start where the excerpt starts, for as long as it lasts', () => {
    const ex = nudgeExcerpt(recommendExcerpt(SONG, 120, 30), 5, 120);
    const photo = planPhotoClip(SONG, 120, 3, ex.duration, ex);
    const cover = planShareClip(SONG, 120, 200, ex.duration, ex);
    expect([photo.start, photo.duration]).toEqual([ex.start, ex.duration]);
    expect([cover.start, cover.duration]).toEqual([ex.start, ex.duration]);
  });

  it('without an excerpt the plans keep choosing for themselves, as before', () => {
    const cover = planShareClip(SONG, 120, 200, 30);
    expect(cover.start).toBe(39.5);
  });
});
