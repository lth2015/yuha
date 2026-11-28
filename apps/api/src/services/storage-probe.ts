import type { StorageAdapter } from '@yuha/providers';

/**
 * Every place the API pod itself writes in the delivery bucket, under its own
 * AWS role. The worker's writes (song masters, scene MVs) run under a
 * different role and are not probed here.
 *
 * Why this exists: official BGM import shipped writing `official-bgm/`, which
 * the API role had no s3:PutObject on, and the first anyone knew was a 500 on
 * the product owner's upload (2026-11-27). Code can't see an IAM policy, so
 * the only honest check runs under the deployment's own identity, at
 * deploy time. A new prefix the API writes belongs in this list.
 */
export const API_STORAGE_WRITES: ReadonlyArray<{ prefix: string; feature: string }> = [
  { prefix: 'official-bgm/masters/', feature: 'official BGM import (master)' },
  { prefix: 'official-bgm/previews/', feature: 'official BGM import (60-second preview)' },
  { prefix: 'official-bgm/covers/', feature: 'official BGM import (cover)' },
  { prefix: 'share-cards/', feature: 'share card' },
  // exportKey(): `<owner id>/<track id>/export-…`. A nil id is nobody's.
  { prefix: '00000000-0000-0000-0000-000000000000/00000000-0000-0000-0000-000000000000/', feature: 'song export' },
];

export interface ProbeResult {
  prefix: string;
  feature: string;
  key: string;
  ok: boolean;
  /** The first step that failed. */
  step?: 'write' | 'read' | 'delete';
  error?: string;
}

function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message.split('\n')[0]}`;
  return String(error);
}

/**
 * Write a small object under each prefix, read it back, delete it. A probe
 * that was written is always deleted, even when the read fails; one that could
 * not be deleted is reported with its key, so the leftover is known.
 */
export async function probeStorage(storage: StorageAdapter, tag: string): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const { prefix, feature } of API_STORAGE_WRITES) {
    const key = `${prefix}yuha-storage-probe-${tag}.txt`;
    const body = Buffer.from(`storage probe ${tag} ${prefix}\n`);
    const result: ProbeResult = { prefix, feature, key, ok: false };
    try {
      await storage.put({ zone: 'delivery', key, body, contentType: 'text/plain' });
    } catch (error) {
      results.push({ ...result, step: 'write', error: describe(error) });
      continue;
    }
    let failure: Pick<ProbeResult, 'step' | 'error'> | undefined;
    try {
      const back = await storage.get('delivery', key);
      if (!back.equals(body)) failure = { step: 'read', error: 'read back different bytes from those written' };
    } catch (error) {
      failure = { step: 'read', error: describe(error) };
    }
    try {
      await storage.remove('delivery', key);
    } catch (error) {
      failure ??= { step: 'delete', error: describe(error) };
    }
    results.push(failure ? { ...result, ...failure } : { ...result, ok: true });
  }
  return results;
}
