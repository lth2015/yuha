/**
 * Videos kept on the device that made them (product owner, 2026-11-26): the
 * server keeps no video, so "My songs" lists the ones this browser saved.
 * Pinned here: what a full device lets go of first, and that one account on
 * a shared browser never sees another's.
 */
import { describe, expect, it } from 'vitest';
import { overLimit, visibleTo, type LocalVideoMeta } from '../apps/web/src/lib/local-videos.js';

const v = (id: string, ownerId: string, createdAt: number, bytes = 10): LocalVideoMeta => ({
  id,
  ownerId,
  trackId: 't',
  title: id,
  kind: 'photo',
  seconds: 60,
  createdAt,
  bytes,
  poster: null,
});

describe('what a full device lets go of', () => {
  it('is nothing while under both limits', () => {
    expect(overLimit([v('a', 'u', 1), v('b', 'u', 2)], { maxCount: 3, maxBytes: 100 })).toEqual([]);
  });
  it('is the oldest first, until the count fits', () => {
    expect(overLimit([v('new', 'u', 3), v('old', 'u', 1), v('mid', 'u', 2)], { maxCount: 2, maxBytes: 1000 })).toEqual(['old']);
  });
  it('is the oldest first, until the bytes fit', () => {
    const all = [v('a', 'u', 1, 40), v('b', 'x', 2, 40), v('c', 'u', 3, 40)];
    expect(overLimit(all, { maxCount: 10, maxBytes: 90 })).toEqual(['a']);
    expect(overLimit(all, { maxCount: 10, maxBytes: 50 })).toEqual(['a', 'b']);
  });
  it('on a shared device, takes the saver’s own videos before anyone else’s', () => {
    const all = [v('theirs', 'x', 1, 40), v('mine-old', 'u', 2, 40), v('mine-new', 'u', 3, 40)];
    expect(overLimit(all, { maxCount: 10, maxBytes: 90 }, 'u')).toEqual(['mine-old']);
    // Only when the saver has nothing older left does someone else's go.
    expect(overLimit(all, { maxCount: 10, maxBytes: 40 }, 'u')).toEqual(['mine-old', 'theirs']);
  });
});

describe('whose videos are listed', () => {
  it('is only the signed-in account’s, newest first', () => {
    const all = [v('a', 'u', 1), v('b', 'other', 2), v('c', 'u', 3)];
    expect(visibleTo(all, 'u').map((x) => x.id)).toEqual(['c', 'a']);
    expect(visibleTo(all, null)).toEqual([]);
  });
});
