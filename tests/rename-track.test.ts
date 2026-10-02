/**
 * Renaming a song, and the screen the name has to pass on the way in.
 *
 * The title was the last thing still stuck in the composer's drawer: chosen
 * once, at generation, by someone who had not heard the song yet. Moving it out
 * of the drawer means being able to change it afterwards, which is why this
 * route exists at all.
 *
 * It is also the second door into a field that had no content screening. The
 * first door — the title passed at creation — was open the whole time, so the
 * test for it is here too: adding rename without closing that would have been
 * building a lock onto one side of an open frame.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getBalance, query } from '@yuha/db';
import { TITLE_MAX_CODEPOINTS } from '@yuha/contracts';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness';

let h: Harness;
beforeAll(async () => { h = await createHarness(); });
beforeEach(async () => { await resetData(); });
afterAll(async () => { await h?.close(); await teardown(); });

const log = () => undefined;

async function deliverSong(user: TestUser, key: string, title?: string): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': key },
    payload: {
      mode: 'simple', prompt: `a quiet walk ${key}`, styles: ['chill'],
      instrumental: true, energy: 0.4, durationSeconds: 30, visibility: 'private',
      ...(title === undefined ? {} : { title }),
    } as never,
  });
  expect(res.statusCode).toBe(202);
  const { jobId } = res.json();
  const { runJobStep } = await import('@yuha/worker/pipeline');
  for (let i = 0; i < 6; i += 1) {
    const job = await query<{ state: string; track_id: string | null }>(
      `SELECT state, track_id FROM generation_jobs WHERE id = ?`, [jobId],
    );
    if (['DELIVERED', 'FAILED', 'REJECTED'].includes(job[0]!.state)) {
      expect(job[0]!.state).toBe('DELIVERED');
      return job[0]!.track_id!;
    }
    await runJobStep({ ctx: h.ctx, owner: `test-${i}`, log }, jobId);
  }
  throw new Error('song did not reach DELIVERED');
}

const rename = (user: TestUser, trackId: string, title: unknown) =>
  h.app.inject({
    method: 'POST', url: `/v1/tracks/${trackId}/title`,
    headers: user.authHeader, payload: { title } as never,
  });

const titleOf = async (trackId: string) =>
  (await query<{ title: string }>(`SELECT title FROM tracks WHERE id = ?`, [trackId]))[0]!.title;

describe('renaming a song', () => {
  it('the owner can rename a delivered song, and the new name is what is served', async () => {
    const user = await h.createUser({ credits: 3 });
    const trackId = await deliverSong(user, 'rename-ok');

    const res = await rename(user, trackId, '雨上がりの放課後');
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe('雨上がりの放課後');
    expect(await titleOf(trackId)).toBe('雨上がりの放課後');

    const got = await h.app.inject({
      method: 'GET', url: `/v1/tracks/${trackId}`, headers: user.authHeader,
    });
    expect(got.json().title).toBe('雨上がりの放課後');
  });

  it('a stranger cannot rename it, and cannot learn that it exists', async () => {
    const owner = await h.createUser({ credits: 3 });
    const other = await h.createUser({ credits: 3 });
    const trackId = await deliverSong(owner, 'rename-stranger');
    const before = await titleOf(trackId);

    const res = await rename(other, trackId, 'mine now');
    // 404, not 403: a 403 would confirm the id names a real song (SEC-01).
    expect(res.statusCode).toBe(404);
    expect(await titleOf(trackId)).toBe(before);
  });

  it('refuses a name that would not have been accepted at creation', async () => {
    const user = await h.createUser({ credits: 3 });
    const trackId = await deliverSong(user, 'rename-blocked');
    const before = await titleOf(trackId);

    const res = await rename(user, trackId, 'https://example.com/track');
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('PROMPT_BLOCKED');
    // The client focuses the field this names; 'prompt' would send the writer
    // to a box that is not even on screen.
    expect(res.json().error.details.field).toBe('title');
    expect(res.json().error.details.appealable).toBe(true);
    expect(await titleOf(trackId)).toBe(before);
  });

  it('refuses a blank name and a name past the limit', async () => {
    const user = await h.createUser({ credits: 3 });
    const trackId = await deliverSong(user, 'rename-blank');
    const before = await titleOf(trackId);

    for (const bad of ['', '   ', '\n\t ', 'あ'.repeat(TITLE_MAX_CODEPOINTS + 1)]) {
      const res = await rename(user, trackId, bad);
      expect(res.statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(await titleOf(trackId)).toBe(before);
  });

  it('stores the name as one line, however it was pasted', async () => {
    // A title is rendered in an h1, a browser tab and a link preview. A pasted
    // newline survives into all three and breaks each one differently.
    const user = await h.createUser({ credits: 3 });
    const trackId = await deliverSong(user, 'rename-ws');

    const res = await rename(user, trackId, '  夏の\n終わり\tに  ');
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe('夏の 終わり に');
    expect(await titleOf(trackId)).toBe('夏の 終わり に');
  });

  it('leaves a deleted song alone', async () => {
    const user = await h.createUser({ credits: 3 });
    const trackId = await deliverSong(user, 'rename-deleted');
    const del = await h.app.inject({
      method: 'DELETE', url: `/v1/tracks/${trackId}`, headers: user.authHeader,
    });
    expect(del.statusCode).toBe(204);

    expect((await rename(user, trackId, 'after the end')).statusCode).toBe(404);
  });
});

describe('the title given at creation', () => {
  it('is screened like every other field, before any spend', async () => {
    const user = await h.createUser({ credits: 3 });
    const res = await h.app.inject({
      method: 'POST', url: '/v1/generations',
      headers: { ...user.authHeader, 'idempotency-key': 'title-blocked' },
      payload: {
        mode: 'simple', prompt: 'a quiet walk', styles: ['chill'],
        instrumental: true, energy: 0.4, durationSeconds: 30,
        visibility: 'private', title: 'https://example.com/track',
      } as never,
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('PROMPT_BLOCKED');
    expect(res.json().error.details.field).toBe('title');
    // A blocked input costs nothing: no reservation, no upstream call.
    expect((await getBalance(user.id)).available).toBe(3);
  });

  it('still accepts an ordinary one', async () => {
    const user = await h.createUser({ credits: 3 });
    const trackId = await deliverSong(user, 'title-ok', '下班路上的那首歌');
    expect(await titleOf(trackId)).toBe('下班路上的那首歌');
  });
});
