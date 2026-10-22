import { describe, expect, it } from 'vitest';
import { resolveNowPlayingLyrics } from '../apps/web/src/lib/now-playing-lyrics.js';

describe('resolveNowPlayingLyrics', () => {
  it('keeps a vocal track in a loading state until its lyrics arrive', () => {
    expect(resolveNowPlayingLyrics(undefined, undefined, 'with_vocals')).toBeUndefined();
  });

  it('uses lyrics carried from song detail before the detail refetch returns', () => {
    expect(resolveNowPlayingLyrics(undefined, 'Words already loaded', 'with_vocals')).toBe('Words already loaded');
  });

  it('only calls a track instrumental when that is confirmed by its mode', () => {
    expect(resolveNowPlayingLyrics(undefined, undefined, 'instrumental')).toBeNull();
  });
});
