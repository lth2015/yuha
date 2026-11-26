/**
 * Videos kept on the device that made them (product owner, 2026-11-26).
 *
 * The server keeps no video: the photo MV's frames carry the owner's photos,
 * and the privacy text promises they are processed only for the length of the
 * encode (docs/PHOTO_MV_SPEC.md). So "My songs" had no videos in it, and the
 * person who made one could not find it again. They are kept here instead, in
 * this browser's IndexedDB, never uploaded, listed per account so a shared
 * browser shows each person only their own.
 *
 * What this cannot promise, and the page says so: another device has none of
 * them, clearing site data removes them, and Safari may clear a site's storage
 * after a stretch of not visiting it. Every call fails soft — a private window
 * or a full disk ends in "not saved", said plainly, never in a broken page.
 */
export interface LocalVideoMeta {
  id: string;
  ownerId: string;
  trackId: string;
  title: string;
  kind: 'photo' | 'cover';
  seconds: number;
  createdAt: number;
  bytes: number;
  /** A small JPEG of an early frame, as a data URL; null when it could not be drawn. */
  poster: string | null;
}
export interface LocalVideo extends LocalVideoMeta {
  blob: Blob;
}

/** Enough for a good few whole-song videos on a phone, not so much the browser objects. */
const LIMITS = { maxCount: 20, maxBytes: 400 * 1024 * 1024 };

/**
 * Which videos to let go of, oldest first, until the rest fit both limits.
 *
 * With `saver`, on a shared device: that account's own older videos go first,
 * then other people's, and the saver's newest (the one being saved) last, so
 * one person filling the device does not quietly empty someone else's list.
 */
export function overLimit(all: LocalVideoMeta[], limits: { maxCount: number; maxBytes: number }, saver?: string): string[] {
  const byAge = [...all].sort((a, b) => a.createdAt - b.createdAt);
  let oldestFirst = byAge;
  if (saver) {
    const own = byAge.filter((v) => v.ownerId === saver);
    const newestOwn = own.pop();
    oldestFirst = [...own, ...byAge.filter((v) => v.ownerId !== saver), ...(newestOwn ? [newestOwn] : [])];
  }
  let count = oldestFirst.length;
  let bytes = oldestFirst.reduce((s, v) => s + v.bytes, 0);
  const drop: string[] = [];
  for (const v of oldestFirst) {
    if (count <= limits.maxCount && bytes <= limits.maxBytes) break;
    drop.push(v.id);
    count -= 1;
    bytes -= v.bytes;
  }
  return drop;
}

/** The signed-in account's videos, newest first; nobody's when nobody is signed in. */
export function visibleTo<T extends LocalVideoMeta>(all: T[], ownerId: string | null | undefined): T[] {
  if (!ownerId) return [];
  return all.filter((v) => v.ownerId === ownerId).sort((a, b) => b.createdAt - a.createdAt);
}

const DB = 'yuha-local';
const STORE = 'videos';

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const req = work(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

async function all(db: IDBDatabase): Promise<LocalVideo[]> {
  return ((await run(db, 'readonly', (s) => s.getAll())) as LocalVideo[] | undefined) ?? [];
}

export type SaveOutcome = 'saved' | 'unavailable' | 'full';

const isQuota = (err: unknown) => (err as DOMException | null)?.name === 'QuotaExceededError';

export async function saveLocalVideo(video: LocalVideo): Promise<SaveOutcome> {
  const db = await open();
  if (!db) return 'unavailable';
  try {
    const existing = await all(db);
    const drop = overLimit([...existing, video], LIMITS, video.ownerId);
    if (drop.includes(video.id)) return 'full';
    /*
     * The browser's own quota for this site can be smaller than ours. When it
     * says no, let go of the next video in the same order and try again,
     * rather than giving up while older videos could have made room.
     */
    const rest = overLimit([...existing, video], { maxCount: 0, maxBytes: 0 }, video.ownerId).filter(
      (id) => id !== video.id && !drop.includes(id),
    );
    for (let attempt = 0; ; attempt += 1) {
      const extra = rest.slice(0, attempt);
      try {
        await run(db, 'readwrite', (s) => {
          for (const id of [...drop, ...extra]) s.delete(id);
          s.put(video);
        });
        break;
      } catch (err) {
        if (!isQuota(err) || attempt >= rest.length) return isQuota(err) ? 'full' : 'unavailable';
      }
    }
    // Ask the browser to keep this site's storage (best effort; Safari may still clear it).
    void navigator.storage?.persist?.().catch(() => undefined);
    return 'saved';
  } catch (err) {
    return isQuota(err) ? 'full' : 'unavailable';
  } finally {
    db.close();
  }
}

/** Adds the list's picture to a saved video, after the video itself is safe. */
export async function setLocalPoster(id: string, poster: string): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    const video = (await run(db, 'readonly', (s) => s.get(id))) as LocalVideo | undefined;
    if (video) await run(db, 'readwrite', (s) => s.put({ ...video, poster }));
  } catch {
    /* the list falls back to a plain tile */
  } finally {
    db.close();
  }
}

export async function listLocalVideos(ownerId: string | null | undefined): Promise<LocalVideo[]> {
  if (!ownerId) return [];
  const db = await open();
  if (!db) return [];
  try {
    return visibleTo(await all(db), ownerId);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export async function deleteLocalVideo(id: string): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    await run(db, 'readwrite', (s) => {
      s.delete(id);
    });
  } catch {
    /* already gone, or storage unavailable: nothing left to show either way */
  } finally {
    db.close();
  }
}

/** A small picture of an early frame, for the list. Null when the browser will not draw it. */
export function posterOf(blob: Blob): Promise<string | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    let done = false;
    const finish = (value: string | null) => {
      if (done) return;
      done = true;
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), 5000);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.onloadeddata = () => {
      video.currentTime = Math.min(1, (video.duration || 2) / 2);
    };
    video.onseeked = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 180;
        canvas.height = 320;
        canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
        window.clearTimeout(timer);
        finish(canvas.toDataURL('image/jpeg', 0.7));
      } catch {
        finish(null);
      }
    };
    video.onerror = () => finish(null);
    video.src = url;
  });
}
