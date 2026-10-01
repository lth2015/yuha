/**
 * Object storage contract (§4.2).
 *
 * Three zones with different access boundaries: `quarantine` for raw provider
 * output (never readable by the delivery path), `delivery` for masters and
 * exports (private, short-lived signed URLs only), and the landing samples
 * which live in `delivery` under a `samples/` prefix.
 */
export type StorageZone = 'quarantine' | 'delivery';

export interface PutResult {
  byteSize: number;
  sha256: string;
}

export interface SignedUrl {
  url: string;
  expiresAt: Date;
}

export interface StorageAdapter {
  readonly kind: 'local' | 's3';
  put(params: {
    zone: StorageZone;
    /** Owner-scoped, unguessable path decided by the caller (SEC-04). */
    key: string;
    body: Buffer;
    contentType: string;
    metadata?: Record<string, string>;
  }): Promise<PutResult>;
  get(zone: StorageZone, key: string): Promise<Buffer>;
  /**
   * Erase one object. Succeeds when the object is already gone.
   *
   * This existed nowhere until account deletion needed it, which meant the
   * product promised to remove someone's songs and export files and had no
   * code that could. Idempotent on purpose: a deletion sweep that has to be
   * re-run must not fail on the objects it already removed, and "absent" is
   * the state the caller wanted either way.
   */
  remove(zone: StorageZone, key: string): Promise<void>;
  /** Short-lived, unguessable download URL. Re-issued on every read. */
  signedUrl(params: {
    zone: StorageZone;
    key: string;
    ttlSeconds: number;
    filename?: string;
  }): Promise<SignedUrl>;
}
