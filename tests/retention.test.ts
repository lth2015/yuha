/**
 * The retention sweep: audio of deleted songs eventually goes.
 *
 * A soft delete takes a song out of the library and leaves the file, which is
 * what makes "I deleted the wrong one" recoverable. Nothing ever came back for
 * those files — every song anybody has ever deleted is still stored — so the
 * retention promise had no expiry behind it and the storage had no floor.
 *
 * Most of these cases are about what the sweep refuses to take. A sweep that
 * runs on a timer and deletes the wrong thing is discovered months later by
 * the person who needed it.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { insertOrder, query } from '@yuha/db';
import { sweepExpiredTrackAudio } from '@yuha/api';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

const log = () => undefined;

async function deliverSong(user: TestUser, key: string): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': key },
    payload: {
      mode: 'simple',
      prompt: `a quiet walk ${key}`,
      styles: ['chill'],
      instrumental: true,
      energy: 0.4,
      durationSeconds: 30,
      visibility: 'private',
    } as never,
  });
  expect(res.statusCode).toBe(202);
  const { jobId } = res.json();
  const { runJobStep } = await import('@yuha/worker/pipeline');
  for (let i = 0; i < 6; i += 1) {
    const job = await query<{ state: string; track_id: string | null }>(
      `SELECT state, track_id FROM generation_jobs WHERE id = ?`,
      [jobId],
    );
    if (job[0]!.state === 'DELIVERED') return job[0]!.track_id!;
    await runJobStep({ ctx: h.ctx, owner: `ret-${i}`, log }, jobId);
  }
  throw new Error('song did not reach DELIVERED');
}

async function keyOf(trackId: string): Promise<string> {
  const rows = await query<{ storage_key: string }>(
    `SELECT storage_key FROM asset_versions WHERE track_id = ?`,
    [trackId],
  );
  return rows[0]!.storage_key;
}

/** Soft-delete a track and backdate it, since the window is in days. */
async function deleteDaysAgo(trackId: string, days: number): Promise<void> {
  await query(
    `UPDATE tracks SET deleted_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL ? DAY), state = 'deleted' WHERE id = ?`,
    [days, trackId],
  );
}

describe('track retention sweep', () => {
  it('removes the audio of a song deleted longer ago than the window', async () => {
    const user = await h.createUser({ credits: 5 });
    const trackId = await deliverSong(user, 'ret-old');
    const key = await keyOf(trackId);
    await deleteDaysAgo(trackId, 91);

    const result = await sweepExpiredTrackAudio(h.ctx);

    expect(result).toEqual({ removed: 1, failed: 0 });
    await expect(h.ctx.storage.get('delivery', key)).rejects.toThrow();
    expect(await query(`SELECT id FROM asset_versions WHERE track_id = ?`, [trackId])).toHaveLength(0);
  });

  it('leaves a song deleted inside the window alone', async () => {
    const user = await h.createUser({ credits: 5 });
    const trackId = await deliverSong(user, 'ret-recent');
    const key = await keyOf(trackId);
    await deleteDaysAgo(trackId, 89);

    expect(await sweepExpiredTrackAudio(h.ctx)).toEqual({ removed: 0, failed: 0 });
    await expect(h.ctx.storage.get('delivery', key)).resolves.toBeInstanceOf(Buffer);
  });

  it('never touches a song that is not deleted at all', async () => {
    const user = await h.createUser({ credits: 5 });
    const trackId = await deliverSong(user, 'ret-live');
    const key = await keyOf(trackId);

    expect(await sweepExpiredTrackAudio(h.ctx)).toEqual({ removed: 0, failed: 0 });
    await expect(h.ctx.storage.get('delivery', key)).resolves.toBeInstanceOf(Buffer);
  });

  it('keeps evidence in an open rights case, however old the deletion is', async () => {
    const user = await h.createUser({ credits: 5 });
    const trackId = await deliverSong(user, 'ret-rights');
    const key = await keyOf(trackId);
    await deleteDaysAgo(trackId, 400);
    await query(
      `INSERT INTO rights_cases (id, case_number, track_id, reporter_name, reporter_email,
                                 claim_type, description, evidence, status)
       VALUES (UUID(), 'RC-RET-1', ?, 'A Label', 'legal@example.test', 'copyright', 'ours', '[]', 'under_review')`,
      [trackId],
    );

    expect(await sweepExpiredTrackAudio(h.ctx)).toEqual({ removed: 0, failed: 0 });
    await expect(h.ctx.storage.get('delivery', key)).resolves.toBeInstanceOf(Buffer);
  });

  it('keeps a song somebody licensed, so the purchase keeps working', async () => {
    const user = await h.createUser({ credits: 5 });
    const buyer = await h.createUser();
    const trackId = await deliverSong(user, 'ret-licensed');
    const key = await keyOf(trackId);
    await deleteDaysAgo(trackId, 400);
    const order = await insertOrder({
      userId: buyer.id,
      priceKey: 'market_license',
      priceVersion: 2,
      kind: 'one_time',
      amountMinor: 980,
      currency: 'jpy',
      idempotencyKey: `ret-licence-${trackId}`,
    });
    await query(
      `INSERT INTO track_licenses (id, track_id, buyer_id, creator_id, order_id, price_paid, currency)
       VALUES (UUID(), ?, ?, ?, ?, 980, 'jpy')`,
      [trackId, buyer.id, user.id, order.id],
    );

    expect(await sweepExpiredTrackAudio(h.ctx)).toEqual({ removed: 0, failed: 0 });
    await expect(h.ctx.storage.get('delivery', key)).resolves.toBeInstanceOf(Buffer);
  });

  it('does nothing at all when retention is switched off', async () => {
    const user = await h.createUser({ credits: 5 });
    const trackId = await deliverSong(user, 'ret-off');
    const key = await keyOf(trackId);
    await deleteDaysAgo(trackId, 400);

    const ctx = { ...h.ctx, config: { ...h.ctx.config, TRACK_RETENTION_DAYS: 0 } };
    expect(await sweepExpiredTrackAudio(ctx)).toEqual({ removed: 0, failed: 0 });
    await expect(h.ctx.storage.get('delivery', key)).resolves.toBeInstanceOf(Buffer);
  });

  /*
   * The asset row outlives a failed removal on purpose. Dropping it would make
   * the file invisible to every future sweep — permanently stored and
   * unreachable, which is the one outcome running the sweep again cannot fix.
   */
  it('keeps the row when the object cannot be removed, so the next sweep retries', async () => {
    const user = await h.createUser({ credits: 5 });
    const trackId = await deliverSong(user, 'ret-fail');
    await deleteDaysAgo(trackId, 400);

    const ctx = {
      ...h.ctx,
      storage: {
        ...h.ctx.storage,
        remove: async () => {
          throw new Error('bucket unreachable');
        },
      },
    } as typeof h.ctx;

    expect(await sweepExpiredTrackAudio(ctx)).toEqual({ removed: 0, failed: 1 });
    expect(await query(`SELECT id FROM asset_versions WHERE track_id = ?`, [trackId])).toHaveLength(1);
  });
});
