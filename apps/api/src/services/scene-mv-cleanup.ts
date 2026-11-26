import { deleteSceneMvs, sceneMvStorageKeys, stopAndScrubSceneMvs } from '@yuha/db';
import type { StorageAdapter } from '@yuha/providers';

/**
 * A song's scene MVs go with the song (migration 0036): when its owner
 * deletes it, when the account goes, when an unclaimed trial is purged.
 *
 * Songs are soft-deleted, so the foreign key's cascade does not do this. The
 * order matters: anything being made is stopped and the person's words are
 * dropped first, unconditionally; then the files; and the rows go only once
 * every file has, so a file that would not delete is still on record for the
 * next attempt rather than orphaned. Returns whether everything went.
 */
export async function removeSceneMvsOfTrack(
  storage: StorageAdapter,
  trackId: string,
  log?: { error: (obj: object, msg: string) => void },
): Promise<boolean> {
  await stopAndScrubSceneMvs(trackId);
  let allGone = true;
  for (const key of await sceneMvStorageKeys(trackId)) {
    try {
      await storage.remove('delivery', key);
    } catch (err) {
      allGone = false;
      log?.error({ err, key }, 'could not remove a scene MV file');
    }
  }
  if (allGone) await deleteSceneMvs(trackId);
  return allGone;
}
