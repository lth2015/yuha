import { deleteSceneMvRow, deleteSceneMvs, sceneMvKeys, sceneMvStorageKeys, stopAndScrubSceneMv, stopAndScrubSceneMvs } from '@yuha/db';
import { listSceneMvsForTrack, uncollectedClipIds } from '@yuha/db';
import type { StorageAdapter, VideoProvider } from '@yuha/providers';

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
  video?: VideoProvider | null,
): Promise<boolean> {
  await stopAndScrubSceneMvs(trackId);
  await discardAtService(video, (await listSceneMvsForTrack(trackId)).map((m) => m.id));
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

/**
 * One MV: its owner deleted it, or its keeping date passed. Same order as
 * above — stopped and the words dropped first, then the files, then the row.
 */
export async function removeSceneMv(
  storage: StorageAdapter,
  id: string,
  log?: { error: (obj: object, msg: string) => void },
  video?: VideoProvider | null,
): Promise<boolean> {
  await stopAndScrubSceneMv(id);
  await discardAtService(video, [id]);
  let allGone = true;
  for (const key of await sceneMvKeys(id)) {
    try {
      await storage.remove('delivery', key);
    } catch (err) {
      allGone = false;
      log?.error({ err, key }, 'could not remove a scene MV file');
    }
  }
  if (allGone) await deleteSceneMvRow(id);
  return allGone;
}

/**
 * Lets the video service go of clips YUHA asked for and never collected: a
 * queued one is cancelled there (its queue holds twenty), a finished one is
 * deleted. Best effort; the service sweeps its own after seven days.
 */
export async function discardAtService(video: VideoProvider | null | undefined, sceneMvIds: string[]): Promise<void> {
  if (!video) return;
  for (const id of sceneMvIds) {
    for (const clip of await uncollectedClipIds(id)) await video.discard(clip).catch(() => undefined);
  }
}
