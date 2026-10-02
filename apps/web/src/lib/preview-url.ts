import { apiFetch } from './api';

/**
 * A preview URL is signed when the track is fetched, not when it is played.
 *
 * `DOWNLOAD_URL_TTL_SECONDS` is 300, so a library left open for six minutes
 * has a row of play buttons that each produce an error and no explanation. The
 * song is fine; the signature is not.
 *
 * Re-signing when the audio errors, rather than on a timer, is deliberate. The
 * client is not told the TTL, a timer would need both clocks to agree, and it
 * would re-sign tracks nobody plays. An error is the one moment we know for
 * certain the URL did not work. The cost is a round trip of latency on the
 * first play after a long idle, which is the trade worth making against a
 * button that silently does nothing.
 */

/**
 * One retry per track, and the whole subtlety is in "one".
 *
 * `error` fires for genuinely broken audio too — a missing object, an
 * unsupported codec — and a retry that re-armed itself would turn one dead
 * file into an unbounded request loop against the API. Starting a track again
 * re-arms it, because pressing play an hour later is a new attempt whose
 * signature will have expired again.
 */
export function createResignGuard() {
  let lastId: string | null = null;
  let spent = false;
  return {
    mayRetry(trackId: string | null): boolean {
      if (!trackId) return false;
      if (trackId !== lastId) {
        lastId = trackId;
        spent = false;
      }
      if (spent) return false;
      spent = true;
      return true;
    },
    /** Called when a track starts: a fresh attempt gets a fresh chance. */
    armFor(trackId: string): void {
      lastId = trackId;
      spent = false;
    },
  };
}

/**
 * Ask the server to sign this track again.
 *
 * `GET /v1/tracks/:id` is `optionalAuth`, so it answers for the owner and for
 * anyone holding a public link — the same two audiences the player serves.
 * Returns null rather than throwing: the caller is already on an error path,
 * and a failure here just means the error stands.
 */
export async function freshPreviewUrl(trackId: string): Promise<string | null> {
  try {
    const track = await apiFetch<{ previewUrl: string | null }>(`/v1/tracks/${trackId}`);
    return track.previewUrl ?? null;
  } catch {
    return null;
  }
}
