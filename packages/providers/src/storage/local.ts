import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import type { PutResult, SignedUrl, StorageAdapter, StorageZone } from './types.js';

export interface LocalStorageOptions {
  /** Filesystem root holding the two zones as subdirectories. */
  root: string;
  /** Public base the signed URL points at (the API's /v1/files route). */
  downloadBaseUrl: string;
  signingSecret: string;
}

/**
 * Local stand-in for S3, used in demo/integration mode.
 *
 * Same interface and the same semantics as the S3 adapter — keys are opaque,
 * downloads only ever happen through a signed URL that the API route verifies
 * in constant time, and the quarantine zone is not reachable through that route
 * at all. Passing tests here is not evidence that real S3 was verified.
 */
export class LocalStorageAdapter implements StorageAdapter {
  readonly kind = 'local' as const;
  private readonly root: string;
  private readonly baseUrl: string;
  private readonly secret: string;

  constructor(opts: LocalStorageOptions) {
    this.root = resolve(opts.root);
    this.baseUrl = opts.downloadBaseUrl.replace(/\/$/, '');
    this.secret = opts.signingSecret;
  }

  private path(zone: StorageZone, key: string): string {
    if (key.includes('..') || key.startsWith('/')) {
      throw new Error('storage key must be a relative path without traversal');
    }
    return join(this.root, zone, key);
  }

  async put(params: {
    zone: StorageZone;
    key: string;
    body: Buffer;
    contentType: string;
    metadata?: Record<string, string>;
  }): Promise<PutResult> {
    const path = this.path(params.zone, params.key);
    await mkdir(dirname(path), { recursive: true });
    // Zone prefix enforced in path(); the explicit resolve check is defence in
    // depth against a key that escapes after joining.
    if (!resolve(path).startsWith(join(this.root, params.zone) + sep) && resolve(path) !== join(this.root, params.zone)) {
      throw new Error('storage key escaped its zone');
    }
    await writeFile(path, params.body);
    return { byteSize: params.body.byteLength, sha256: createHash('sha256').update(params.body).digest('hex') };
  }

  async get(zone: StorageZone, key: string): Promise<Buffer> {
    return readFile(this.path(zone, key));
  }

  async signedUrl(params: {
    zone: StorageZone;
    key: string;
    ttlSeconds: number;
    filename?: string;
  }): Promise<SignedUrl> {
    const expiresAt = new Date(Date.now() + params.ttlSeconds * 1000);
    const expires = Math.floor(expiresAt.getTime() / 1000);
    const sig = LocalStorageAdapter.signature(this.secret, params.zone, params.key, expires);
    const url = new URL(this.baseUrl);
    url.searchParams.set('zone', params.zone);
    url.searchParams.set('key', params.key);
    url.searchParams.set('expires', String(expires));
    url.searchParams.set('sig', sig);
    if (params.filename) url.searchParams.set('filename', params.filename);
    return { url: url.toString(), expiresAt };
  }

  static signature(secret: string, zone: string, key: string, expires: number): string {
    return createHmac('sha256', secret).update(`${zone}\n${key}\n${expires}`).digest('hex');
  }

  /** Constant-time verification of a link the API route received. */
  static verify(params: { secret: string; zone: string; key: string; expires: number; sig: string }): boolean {
    if (params.expires * 1000 < Date.now()) return false;
    const expected = Buffer.from(LocalStorageAdapter.signature(params.secret, params.zone, params.key, params.expires));
    const given = Buffer.from(params.sig);
    return expected.length === given.length && timingSafeEqual(expected, given);
  }
}
