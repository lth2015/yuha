import type { VocalMode } from '@yuha/contracts';

/**
 * `undefined` means details are still unknown; `null` means we know this is
 * an instrumental.  Keeping those states separate stops a loading vocal song
 * being labelled as an instrumental.
 */
export function resolveNowPlayingLyrics(
  detailLyrics: string | null | undefined,
  carriedLyrics: string | null | undefined,
  vocalMode: VocalMode | undefined,
): string | null | undefined {
  if (detailLyrics !== undefined) return detailLyrics;
  if (carriedLyrics !== undefined) return carriedLyrics;
  return vocalMode === 'with_vocals' ? undefined : null;
}
