import { createHash } from 'node:crypto';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { PutResult, SignedUrl, StorageAdapter, StorageZone } from './types.js';

export interface S3StorageOptions {
  region: string;
  quarantineBucket: string;
  deliveryBucket: string;
  /** SSE-KMS key id; bucket defaults apply when omitted. */
  kmsKeyId?: string;
}

/**
 * S3 storage for production (§4.2, SEC-04).
 *
 * Buckets are private by configuration in Terraform; nothing here ever makes
 * an object public. Downloads go through short-lived presigned URLs, and the
 * two zones are physically separate buckets so a policy mistake on one cannot
 * expose the other.
 */
export class S3StorageAdapter implements StorageAdapter {
  readonly kind = 's3' as const;
  private readonly client: S3Client;
  private readonly buckets: Record<StorageZone, string>;
  private readonly kmsKeyId?: string;

  constructor(opts: S3StorageOptions) {
    this.client = new S3Client({ region: opts.region });
    this.buckets = { quarantine: opts.quarantineBucket, delivery: opts.deliveryBucket };
    this.kmsKeyId = opts.kmsKeyId;
  }

  async put(params: {
    zone: StorageZone;
    key: string;
    body: Buffer;
    contentType: string;
    metadata?: Record<string, string>;
  }): Promise<PutResult> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.buckets[params.zone],
        Key: params.key,
        Body: params.body,
        ContentType: params.contentType,
        ...(params.metadata ? { Metadata: params.metadata } : {}),
        ...(this.kmsKeyId
          ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: this.kmsKeyId }
          : { ServerSideEncryption: 'AES256' }),
      }),
    );
    return { byteSize: params.body.byteLength, sha256: createHash('sha256').update(params.body).digest('hex') };
  }

  async get(zone: StorageZone, key: string): Promise<Buffer> {
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.buckets[zone], Key: key }),
    );
    const bytes = await res.Body?.transformToByteArray();
    if (!bytes) throw new Error(`empty object body for s3://${this.buckets[zone]}/${key}`);
    return Buffer.from(bytes);
  }

  /**
   * S3 answers 204 whether or not the object was there, so this is idempotent
   * without a prior HEAD — what the caller wants, and one fewer request.
   *
   * **Erasure here is not immediate, and whoever quotes a deletion promise
   * needs to know it.** The delivery bucket has versioning enabled
   * (`infra/terraform/data.tf`, `aws_s3_bucket_versioning.delivery`), so this
   * call writes a delete marker and the object becomes a noncurrent version
   * rather than disappearing. The lifecycle rule `clean-up-old-versions` on
   * the same bucket expires noncurrent versions after 30 days, so the bytes do
   * go — on day 30, not on the day somebody asked.
   *
   * Deleting every version by id instead would make it immediate and would
   * also hand any caller the power to erase history on a bucket that is
   * versioned precisely so mistakes can be undone. That trade belongs to
   * whoever writes the retention policy, not to this method, so it stays as it
   * is and the delay is written down here and in the deletion flow.
   */
  async remove(zone: StorageZone, key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.buckets[zone], Key: key }));
  }

  async signedUrl(params: {
    zone: StorageZone;
    key: string;
    ttlSeconds: number;
    filename?: string;
  }): Promise<SignedUrl> {
    const command = new GetObjectCommand({
      Bucket: this.buckets[params.zone],
      Key: params.key,
      ResponseContentDisposition: params.filename
        ? `attachment; filename*=UTF-8''${encodeURIComponent(params.filename)}`
        : 'inline',
      ...(params.key.endsWith('.wav') ? { ResponseContentType: 'audio/wav' } : {}),
    });
    const url = await getSignedUrl(this.client, command, { expiresIn: params.ttlSeconds });
    return { url, expiresAt: new Date(Date.now() + params.ttlSeconds * 1000) };
  }
}
