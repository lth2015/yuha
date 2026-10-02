/**
 * A library left open long enough has play buttons that fail.
 *
 * `previewUrl` is signed when the track data is fetched and lasts
 * `DOWNLOAD_URL_TTL_SECONDS`, which is 300. The player puts that string into
 * `audio.src` and nothing ever refreshes it, so a page open for six minutes has
 * a row of buttons that each produce an error and no explanation. The song is
 * fine; the signature is not.
 *
 * Re-signing when the audio errors, rather than on a timer, is deliberate. The
 * client does not know the TTL, both clocks would have to agree, and a timer
 * would re-sign tracks nobody plays. An error is the one moment we know for
 * certain the URL did not work.
 *
 * Exactly once per track, which is the whole subtlety. The `error` event fires
 * for genuinely broken audio too, and a retry that re-armed itself would turn
 * one dead file into an unbounded request loop against the API.
 */
import { describe, expect, it } from 'vitest';
import { createResignGuard } from '../apps/web/src/lib/preview-url.js';

describe('deciding whether a failed play is worth one more try', () => {
  it('allows a retry the first time a track fails', () => {
    const guard = createResignGuard();
    expect(guard.mayRetry('t1')).toBe(true);
  });

  it('refuses a second retry for the same track, so a dead file cannot loop', () => {
    const guard = createResignGuard();
    expect(guard.mayRetry('t1')).toBe(true);
    expect(guard.mayRetry('t1')).toBe(false);
    expect(guard.mayRetry('t1')).toBe(false);
  });

  it('gives the next track its own one chance', () => {
    const guard = createResignGuard();
    guard.mayRetry('t1');
    expect(guard.mayRetry('t1')).toBe(false);
    expect(guard.mayRetry('t2')).toBe(true);
    expect(guard.mayRetry('t2')).toBe(false);
  });

  it('re-arms when a track is started again', () => {
    // Pressing play on the same song an hour later is a new attempt, and its
    // signature will have expired again.
    const guard = createResignGuard();
    guard.mayRetry('t1');
    expect(guard.mayRetry('t1')).toBe(false);
    guard.armFor('t1');
    expect(guard.mayRetry('t1')).toBe(true);
  });

  it('does not let returning to an earlier track reuse its spent chance', () => {
    // t1 fails and is retried, the listener skips to t2, then comes back to t1
    // without pressing play — the queue advanced. t1 has had its try.
    const guard = createResignGuard();
    guard.mayRetry('t1');
    guard.mayRetry('t2');
    expect(guard.mayRetry('t2')).toBe(false);
    // Back to t1 by the same route: a fresh track for the guard, which is the
    // honest reading — this is a new load of it, not the one that failed.
    expect(guard.mayRetry('t1')).toBe(true);
  });

  it('says no when there is no track to retry', () => {
    const guard = createResignGuard();
    expect(guard.mayRetry(null)).toBe(false);
    expect(guard.mayRetry('')).toBe(false);
  });
});
