/**
 * SEC-11, carried out rather than promised.
 *
 * `POST /v1/me/deletion-request` has answered with a ticket and a statement of
 * what is kept and what goes since the day it was written, and nothing ever
 * executed it: the only trace was one `analytics_events` row, which is an
 * append-only measurement log with no states and no queue. These tests cover
 * the part that now has to mean it.
 *
 * Most of them are about what erasure does NOT take. Deleting the right things
 * is the easy half; a run that also takes a song somebody else bought, or
 * evidence in an open rights case, cannot be undone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getUser, insertOrder, query } from '@yuha/db';
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
    await runJobStep({ ctx: h.ctx, owner: `del-${i}`, log }, jobId);
  }
  throw new Error('song did not reach DELIVERED');
}

async function requestDeletion(user: TestUser) {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/me/deletion-request',
    headers: user.authHeader,
    payload: {} as never,
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

/** The admin row id for a user's open request. */
async function deletionId(userId: string): Promise<string> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM account_deletions WHERE user_id = ? ORDER BY requested_at DESC LIMIT 1`,
    [userId],
  );
  return rows[0]!.id;
}

async function verifyAndExecute(admin: TestUser, id: string) {
  const v = await h.app.inject({
    method: 'POST',
    url: `/v1/admin/deletions/${id}/verify`,
    headers: admin.authHeader,
    payload: { reason: 'identity confirmed by passport' } as never,
  });
  expect(v.statusCode).toBe(200);
  const e = await h.app.inject({
    method: 'POST',
    url: `/v1/admin/deletions/${id}/execute`,
    headers: admin.authHeader,
    payload: { reason: 'identity confirmed by passport' } as never,
  });
  return e;
}

describe('requesting deletion', () => {
  it('records a row that can be worked, not only an analytics event', async () => {
    const user = await h.createUser();
    const body = await requestDeletion(user);

    const rows = await query<{ ticket: string; status: string }>(
      `SELECT ticket, status FROM account_deletions WHERE user_id = ?`,
      [user.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('requested');
    expect(rows[0]!.ticket).toBe(body.ticket);
  });

  it('asking twice returns the first ticket instead of opening a second erasure', async () => {
    const user = await h.createUser();
    const first = await requestDeletion(user);
    const second = await requestDeletion(user);

    expect(second.ticket).toBe(first.ticket);
    const rows = await query(`SELECT id FROM account_deletions WHERE user_id = ?`, [user.id]);
    expect(rows).toHaveLength(1);
  });

  it('tells the user that licensed songs are kept, and when audio really goes', async () => {
    const user = await h.createUser();
    const body = await requestDeletion(user);
    // The list used to promise "your songs and export files" are removed while
    // the code had to keep the ones other people bought.
    expect(body.retainedCodes).toContain('licensed_by_others');
    expect(body.audioErasureDays).toBe(30);
  });
});

describe('executing deletion', () => {
  it('needs verification first, and a stranger cannot do either step', async () => {
    const user = await h.createUser();
    const other = await h.createUser();
    await requestDeletion(user);
    const id = await deletionId(user.id);

    const notAdmin = await h.app.inject({
      method: 'POST',
      url: `/v1/admin/deletions/${id}/verify`,
      headers: other.authHeader,
      payload: { reason: 'let me in please' } as never,
    });
    expect(notAdmin.statusCode).toBe(403);

    const admin = await h.createUser({ role: 'admin' });
    const tooSoon = await h.app.inject({
      method: 'POST',
      url: `/v1/admin/deletions/${id}/execute`,
      headers: admin.authHeader,
      payload: { reason: 'skipping the check' } as never,
    });
    expect(tooSoon.statusCode).toBe(409);
  });

  it('erases the songs and their stored audio, and anonymises the account', async () => {
    const user = await h.createUser({ credits: 5 });
    const admin = await h.createUser({ role: 'admin' });
    const trackId = await deliverSong(user, 'del-plain');

    const assets = await query<{ storage_key: string }>(
      `SELECT storage_key FROM asset_versions WHERE track_id = ?`,
      [trackId],
    );
    expect(assets.length).toBeGreaterThan(0);
    await requestDeletion(user);

    const res = await verifyAndExecute(admin, await deletionId(user.id));
    expect(res.statusCode).toBe(200);
    expect(res.json().outcome.tracksErased).toBe(1);
    expect(res.json().outcome.objectsRemoved).toBeGreaterThan(0);
    expect(res.json().outcome.objectsFailed).toBe(0);

    // The object is really gone, not just the row.
    await expect(h.ctx.storage.get('delivery', assets[0]!.storage_key)).rejects.toThrow();
    expect(await query(`SELECT id FROM asset_versions WHERE track_id = ?`, [trackId])).toHaveLength(0);

    const after = await getUser(user.id);
    expect(after!.deleted_at).not.toBeNull();
    expect(after!.email).not.toBe(user.email);
    expect(after!.display_name).toBeNull();
    // TINYINT(1) comes back as a real boolean — createPool's typeCast does
    // that deliberately, and `UserRow.marketing_opt_in` is typed `boolean`.
    expect(after!.marketing_opt_in).toBe(false);
  });

  /*
   * The two holds that cannot be undone if they are got wrong. Both are
   * asserted on the stored object, not only on the row: a track row kept while
   * its audio was deleted would read as "retained" and be useless.
   */
  it('keeps a song that is under an open rights case', async () => {
    const user = await h.createUser({ credits: 5 });
    const admin = await h.createUser({ role: 'admin' });
    const trackId = await deliverSong(user, 'del-rights');
    const key = (
      await query<{ storage_key: string }>(`SELECT storage_key FROM asset_versions WHERE track_id = ?`, [trackId])
    )[0]!.storage_key;

    await query(
      `INSERT INTO rights_cases (id, case_number, track_id, reporter_name, reporter_email,
                                 claim_type, description, evidence, status)
       VALUES (UUID(), 'RC-DEL-1', ?, 'A Label', 'legal@example.test', 'copyright', 'sounds like ours', '[]', 'under_review')`,
      [trackId],
    );

    await requestDeletion(user);
    const res = await verifyAndExecute(admin, await deletionId(user.id));

    expect(res.json().outcome.tracksErased).toBe(0);
    expect(res.json().outcome.held).toEqual([{ trackId, reason: 'rights_case_open' }]);
    await expect(h.ctx.storage.get('delivery', key)).resolves.toBeInstanceOf(Buffer);
  });

  it('keeps a song somebody else has licensed, so their purchase keeps working', async () => {
    const user = await h.createUser({ credits: 5 });
    const buyer = await h.createUser();
    const admin = await h.createUser({ role: 'admin' });
    const trackId = await deliverSong(user, 'del-licensed');
    const key = (
      await query<{ storage_key: string }>(`SELECT storage_key FROM asset_versions WHERE track_id = ?`, [trackId])
    )[0]!.storage_key;

    const order = await insertOrder({
      userId: buyer.id,
      priceKey: 'market_license',
      priceVersion: 1,
      kind: 'one_time',
      amountMinor: 980,
      currency: 'jpy',
      idempotencyKey: `del-licence-${trackId}`,
    });
    await query(
      `INSERT INTO track_licenses (id, track_id, buyer_id, creator_id, order_id, price_paid, currency)
       VALUES (UUID(), ?, ?, ?, ?, 980, 'jpy')`,
      [trackId, buyer.id, user.id, order.id],
    );

    await requestDeletion(user);
    const res = await verifyAndExecute(admin, await deletionId(user.id));

    expect(res.json().outcome.tracksErased).toBe(0);
    expect(res.json().outcome.held).toEqual([{ trackId, reason: 'licensed_by_others' }]);
    await expect(h.ctx.storage.get('delivery', key)).resolves.toBeInstanceOf(Buffer);
  });

  it('records what it did on the request, so "deleted" is not taken on trust', async () => {
    const user = await h.createUser({ credits: 5 });
    const admin = await h.createUser({ role: 'admin' });
    await deliverSong(user, 'del-outcome');
    await requestDeletion(user);
    const id = await deletionId(user.id);

    await verifyAndExecute(admin, id);

    const rows = await query<{ status: string; outcome: unknown; executed_at: Date | null }>(
      `SELECT status, outcome, executed_at FROM account_deletions WHERE id = ?`,
      [id],
    );
    expect(rows[0]!.status).toBe('executed');
    expect(rows[0]!.executed_at).not.toBeNull();
    expect(rows[0]!.outcome).toMatchObject({ tracksErased: 1 });
  });

  it('cannot be executed twice', async () => {
    const user = await h.createUser({ credits: 5 });
    const admin = await h.createUser({ role: 'admin' });
    await deliverSong(user, 'del-twice');
    await requestDeletion(user);
    const id = await deletionId(user.id);

    expect((await verifyAndExecute(admin, id)).statusCode).toBe(200);
    const again = await h.app.inject({
      method: 'POST',
      url: `/v1/admin/deletions/${id}/execute`,
      headers: admin.authHeader,
      payload: { reason: 'trying again' } as never,
    });
    expect(again.statusCode).toBe(409);
  });
});
