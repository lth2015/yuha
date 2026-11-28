import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StorageAdapter, StorageZone } from '@yuha/providers';
import { API_STORAGE_WRITES, probeStorage } from '../apps/api/src/services/storage-probe.js';

/** An in-memory bucket whose policy denies the given action under the given prefixes. */
function bucket(deny: Partial<Record<'put' | 'get' | 'remove', string[]>> = {}) {
  const objects = new Map<string, Buffer>();
  const denied = (action: 'put' | 'get' | 'remove', key: string) => {
    if ((deny[action] ?? []).some((prefix) => key.startsWith(prefix))) {
      throw Object.assign(new Error(`not authorized to perform: s3:${action} on ${key}`), { name: 'AccessDenied' });
    }
  };
  const storage = {
    kind: 's3',
    async put({ zone, key, body }: { zone: StorageZone; key: string; body: Buffer }) {
      denied('put', key);
      objects.set(`${zone}:${key}`, body);
      return { byteSize: body.length, sha256: '' };
    },
    async get(zone: StorageZone, key: string) {
      denied('get', key);
      const body = objects.get(`${zone}:${key}`);
      if (!body) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      return body;
    },
    async remove(zone: StorageZone, key: string) {
      denied('remove', key);
      objects.delete(`${zone}:${key}`);
    },
    async signedUrl() { throw new Error('unused'); },
  } as unknown as StorageAdapter;
  return { storage, objects };
}

describe('storage probe', () => {
  it('covers every prefix the API pod writes, including the official BGM folders', () => {
    const prefixes = API_STORAGE_WRITES.map((w) => w.prefix);
    expect(prefixes).toEqual(expect.arrayContaining([
      'official-bgm/masters/', 'official-bgm/previews/', 'official-bgm/covers/', 'share-cards/',
    ]));
    // User exports live under the owner's id, not a fixed folder.
    expect(API_STORAGE_WRITES.some((w) => /^[0-9a-f-]{36}\/[0-9a-f-]{36}\/$/.test(w.prefix))).toBe(true);
  });

  it('lists every fixed folder that API code writing storage builds a key under', () => {
    // A new folder written by the API pod that is not probed is the
    // official-bgm/ outage again: shipped, and first seen as a 500.
    const files = (readdirSync('apps/api/src', { recursive: true }) as string[])
      .filter((f) => f.endsWith('.ts') && !f.includes('storage-probe'))
      .map((f) => readFileSync(join('apps/api/src', f), 'utf8'))
      .filter((src) => src.includes('storage.put'));
    const folders = files.flatMap((src) => [...src.matchAll(/`([a-z][a-z0-9-]*\/(?:[a-z0-9-]+\/)*)\$\{/g)].map((m) => m[1]!));
    expect(folders.length).toBeGreaterThan(0);
    const probed = API_STORAGE_WRITES.map((w) => w.prefix);
    expect(folders.filter((f) => !probed.includes(f))).toEqual([]);
  });

  it('passes and leaves nothing behind when every write, read and delete is allowed', async () => {
    const { storage, objects } = bucket();
    const results = await probeStorage(storage, 'run-1');
    expect(results.every((r) => r.ok)).toBe(true);
    expect(objects.size).toBe(0);
  });

  it('names the prefix and the action that was refused', async () => {
    const { storage } = bucket({ put: ['official-bgm/'] });
    const results = await probeStorage(storage, 'run-2');
    const failed = results.filter((r) => !r.ok);
    expect(failed.map((r) => r.prefix).sort()).toEqual(['official-bgm/covers/', 'official-bgm/masters/', 'official-bgm/previews/']);
    expect(failed[0]).toMatchObject({ step: 'write', error: expect.stringContaining('AccessDenied') });
    expect(results.find((r) => r.prefix === 'share-cards/')?.ok).toBe(true);
  });

  it('reports a probe it could write but not delete, so the leftover is known', async () => {
    const { storage, objects } = bucket({ remove: ['share-cards/'] });
    const result = (await probeStorage(storage, 'run-3')).find((r) => r.prefix === 'share-cards/');
    expect(result).toMatchObject({ ok: false, step: 'delete' });
    expect(result?.key).toMatch(/^share-cards\/.*run-3/);
    expect(objects.size).toBe(1);
  });

  it('fails when what it reads back is not what it wrote', async () => {
    const { storage } = bucket();
    const lying = { ...storage, kind: 's3', get: async () => Buffer.from('something else') } as unknown as StorageAdapter;
    const results = await probeStorage(lying, 'run-4');
    expect(results.every((r) => !r.ok && r.step === 'read')).toBe(true);
  });
});
