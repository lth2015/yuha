import type { VocalMode } from '@yuha/contracts';
import { sungLyrics } from './lyrics';

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
  // No voice, or nothing but section tags: no words to follow (lib/lyrics.ts).
  if (vocalMode === 'instrumental') return null;
  const known = detailLyrics !== undefined ? detailLyrics : carriedLyrics;
  if (known !== undefined) return sungLyrics({ vocalMode: vocalMode ?? 'with_vocals', lyrics: known });
  return vocalMode === 'with_vocals' ? undefined : null;
}
