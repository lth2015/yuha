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
  /** Short-lived, unguessable download URL. Re-issued on every read. */
  signedUrl(params: {
    zone: StorageZone;
    key: string;
    ttlSeconds: number;
    filename?: string;
  }): Promise<SignedUrl>;
}
