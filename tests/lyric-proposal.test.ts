/**
 * "Align it again", for one song, by its owner (docs/MV_LYRIC_SYNC_UX_SPEC.md,
 * phase 2; docs/LYRIC_ALIGNMENT.md).
 *
 * The aligner is asked again with the song's own audio — the DGX keeps its
 * renders only days, YUHA keeps every song — and what comes back is a
 * proposal: the owner listens before anything changes. Pinned here: the saved
 * timing is never touched, nothing is charged, an estimate is never offered as
 * an alignment, and the limits that keep one person from queueing the GPU.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import type { LyricTimings } from '@yuha/contracts';
import { claimOutboxBatch, execute, insertLyricProposal, qualityReport, queryOne, storeDeliveredLyricTimings, withTx } from '@yuha/db';
import type { AlignmentProvider, AlignmentRequest, AlignmentResult } from '@yuha/providers';
import { runJobStep } from '@yuha/worker/pipeline';
import { balanceOf, createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
let off: Harness;
let original: AlignmentProvider;
const LYRICS = '[Verse]\nlo-fi hearts\n[Chorus]\nslow down';
const LINES = [
  { text: 'lo-fi hearts', section: 'Verse', start: 4, end: 7 },
  { text: 'slow down', section: 'Chorus', start: 9, end: 12 },
];

beforeAll(async () => {
  h = await createHarness({ FEATURE_LYRIC_AUTO_ALIGN_ENABLED: 'true' });
  off = await createHarness();
  original = h.ctx.alignment;
});
beforeEach(async () => {
  await resetData();
  setAligner(original);
});
afterAll(async () => {
  await h?.close();
  await off?.close();
  await teardown();
});

function setAligner(a: AlignmentProvider) {
  (h.ctx as { alignment: AlignmentProvider }).alignment = a;
}
const answering = (result: AlignmentResult, seen?: AlignmentRequest[]): AlignmentProvider => ({
  kind: 'fake-dgx',
  align: async (req) => {
    seen?.push(req);
    return result;
  },
});

async function song(user: TestUser, body: Record<string, unknown> = {}): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `prop-${randomUUID()}` },
    payload: { mode: 'custom', prompt: 'a quiet walk', styles: ['chill'], instrumental: false, durationSeconds: 30, lyrics: LYRICS, ...body } as never,
  });
  expect(res.statusCode).toBe(202);
  const jobId = res.json().jobId as string;
  const rows = await withTx((tx) => claimOutboxBatch(50, tx));
  for (const row of rows) await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  for (let i = 0; i < 6; i += 1) {
    await runJobStep({ ctx: h.ctx, owner: `p-${i}`, log: () => undefined }, jobId);
    const t = await queryOne<{ id: string }>(`SELECT id FROM tracks WHERE job_id = ?`, [jobId]);
    if (t) return t.id;
  }
  throw new Error('not delivered');
}

const ask = (who: TestUser, id: string) =>
  h.app.inject({ method: 'POST', url: `/v1/tracks/${id}/lyric-proposal`, headers: who.authHeader });
const apply = (who: TestUser, id: string, proposalId: string) =>
  h.app.inject({ method: 'POST', url: `/v1/tracks/${id}/lyric-proposal/${proposalId}/apply`, headers: who.authHeader });
const read = (who: TestUser, id: string) =>
  h.app.inject({ method: 'GET', url: `/v1/tracks/${id}/lyric-proposal`, headers: who.authHeader });

/** Until the queue has answered this song's request. */
async function settled(who: TestUser, id: string) {
  for (let i = 0; i < 100; i += 1) {
    const body = (await read(who, id)).json() as { id: string; status: string; timings?: LyricTimings; failure?: string };
    if (body.status === 'ready' || body.status === 'failed') return body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('the proposal never settled');
}
const savedTimings = async (id: string) =>
  ((await queryOne<{ t: string | null }>(`SELECT CAST(lyric_timings AS CHAR) AS t FROM tracks WHERE id = ?`, [id]))!.t);

describe('aligning one song again', () => {
  it('asks the aligner with the song itself, and offers what it heard without changing the song', async () => {
    const user = await h.createUser({ credits: 5 });
    const id = await song(user);
    const before = await savedTimings(id);
    const credits = await balanceOf(user.id);
    const seen: AlignmentRequest[] = [];
    setAligner(answering({ status: 'ok', timings: { source: 'aligned', aligner: 'spark-whisper', lines: LINES } }, seen));

    const res = await ask(user, id);
    expect(res.statusCode).toBe(202);
    const out = await settled(user, id);
    expect(out.status).toBe('ready');
    expect(out.timings?.source).toBe('aligned');
    expect(out.timings?.lines.map((l) => l.start)).toEqual([4, 9]);
    // The song's own audio went to the aligner, and the lyrics it sings.
    expect(seen).toHaveLength(1);
    expect(seen[0]!.audio?.length ?? 0).toBeGreaterThan(1000);
    expect(seen[0]!.lyrics).toBe(LYRICS);
    // Nothing saved, nothing charged.
    expect(await savedTimings(id)).toBe(before);
    expect(await balanceOf(user.id)).toEqual(credits);
  }, 60_000);

  it('retires client-supplied timings and lets only the owner adopt the aligner result', async () => {
    const owner = await h.createUser({ credits: 5 });
    const other = await h.createUser();
    const id = await song(owner);
    const before = await savedTimings(id);
    const write = await h.app.inject({
      method: 'POST',
      url: `/v1/tracks/${id}/lyric-timings`,
      headers: owner.authHeader,
      payload: { source: 'corrected', aligner: 'human', lines: LINES },
    });
    expect(write.statusCode).toBe(409);
    expect(write.json().error.message).toMatch(/refresh/i);
    expect(await savedTimings(id)).toBe(before);
    setAligner(answering({ status: 'ok', timings: { source: 'aligned', aligner: 'spark-whisper', lines: LINES } }));
    await ask(owner, id);
    const proposal = await settled(owner, id);
    expect((await apply(other, id, proposal.id)).statusCode).toBe(404);
    expect((await apply(owner, id, randomUUID())).statusCode).toBe(409);
    const adopted = await apply(owner, id, proposal.id);
    expect(adopted.statusCode).toBe(200);
    expect(adopted.json()).toMatchObject({ trackId: id, lyricSync: 'synced', lyricTimings: proposal.timings });
    expect(JSON.parse((await savedTimings(id))!)).toMatchObject({ ...proposal.timings, appliedProposalId: proposal.id });
    const view = await h.app.inject({ method: 'GET', url: `/v1/tracks/${id}`, headers: owner.authHeader });
    expect(view.json().lyricTimings).toEqual(proposal.timings);
    expect((await read(owner, id)).json()).toMatchObject({ applied: true });
    expect((await apply(owner, id, proposal.id)).statusCode).toBe(200);
    expect(await storeDeliveredLyricTimings({
      trackId: id, lyrics: LYRICS, timings: { source: 'aligned', aligner: 'late-worker', lines: LINES },
    })).toBe(false);
    expect(JSON.parse((await savedTimings(id))!)).toHaveProperty('appliedProposalId', proposal.id);
  }, 60_000);

  it('keeps corrected timings and rejects a proposal for a replaced master or changed lyrics', async () => {
    const owner = await h.createUser({ credits: 5 });
    const id = await song(owner);
    setAligner(answering({ status: 'ok', timings: { source: 'aligned', aligner: 'spark-whisper', lines: LINES } }));
    await ask(owner, id);
    const proposal = await settled(owner, id);
    const corrected = { source: 'corrected', aligner: 'human', lines: LINES };
    await execute('UPDATE tracks SET lyric_timings = ? WHERE id = ?', [JSON.stringify(corrected), id]);
    expect((await apply(owner, id, proposal.id)).statusCode).toBe(409);
    expect(JSON.parse((await savedTimings(id))!)).toEqual(corrected);
    await execute('UPDATE tracks SET lyric_timings = NULL, lyrics = ? WHERE id = ?', [LYRICS + '\nMore words', id]);
    expect((await apply(owner, id, proposal.id)).statusCode).toBe(409);
    await execute('UPDATE tracks SET lyrics = ? WHERE id = ?', [LYRICS, id]);
    await execute("UPDATE asset_versions SET sha256 = ? WHERE track_id = ? AND kind = 'master'", ['f'.repeat(64), id]);
    expect((await apply(owner, id, proposal.id)).statusCode).toBe(409);
    expect(await savedTimings(id)).toBeNull();
  }, 60_000);

  it('rejects an alignment with a line starting outside the song', async () => {
    const owner = await h.createUser({ credits: 5 });
    const id = await song(owner);
    setAligner(answering({
      status: 'ok', timings: { source: 'aligned', aligner: 'spark-whisper',
        lines: [LINES[0]!, { ...LINES[1]!, start: 1000, end: 1001 }] },
    }));
    await ask(owner, id);
    const proposal = await settled(owner, id);
    expect(proposal).toMatchObject({ status: 'failed', failure: 'error' });
    expect((await apply(owner, id, proposal.id)).statusCode).toBe(409);
  }, 60_000);

  it('does not offer an estimate as an alignment, and says why it could not hear', async () => {
    const user = await h.createUser({ credits: 5 });
    const id = await song(user);
    setAligner(
      answering({
        status: 'ok',
        timings: { source: 'estimated', aligner: 'estimated-v1', lines: LINES },
        fallbackReason: 'aligner_http_422 low_coverage coverage=0.31',
      }),
    );
    await ask(user, id);
    const out = await settled(user, id);
    expect(out.status).toBe('failed');
    expect(out.failure).toBe('low_coverage');
    expect(out.timings).toBeUndefined();
  }, 60_000);

  it('is the owner’s alone, and only for a song that sings words', async () => {
    const user = await h.createUser({ credits: 10 });
    const other = await h.createUser();
    const id = await song(user);
    expect((await ask(other, id)).statusCode).toBe(404);
    expect((await read(other, id)).statusCode).toBe(404);
    const inst = await song(user, { instrumental: true, lyrics: undefined, prompt: 'rain on glass' });
    expect((await ask(user, inst)).statusCode).toBe(409);
  }, 60_000);

  it('answers a second ask with the first while it waits, and allows three a day', async () => {
    const user = await h.createUser({ credits: 5 });
    const id = await song(user);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    setAligner({
      kind: 'fake-dgx',
      align: async () => {
        await gate;
        return { status: 'ok', timings: { source: 'aligned', aligner: 'spark-whisper', lines: LINES } };
      },
    });
    const first = (await ask(user, id)).json() as { id: string };
    const again = (await ask(user, id)).json() as { id: string };
    expect(again.id).toBe(first.id);
    release();
    await settled(user, id);
    setAligner(answering({ status: 'ok', timings: { source: 'aligned', aligner: 'spark-whisper', lines: LINES } }));
    for (let i = 0; i < 2; i += 1) {
      expect((await ask(user, id)).statusCode).toBe(202);
      await settled(user, id);
    }
    expect((await ask(user, id)).statusCode).toBe(429);
  }, 60_000);

  it('takes two quick asks as one, and does not count the platform’s own failures against the day', async () => {
    const user = await h.createUser({ credits: 5 });
    const id = await song(user);
    setAligner({ kind: 'fake-dgx', align: async () => { await new Promise((r) => setTimeout(r, 200)); return { status: 'failed', reason: 'aligner_threw: fetch failed' }; } });
    const [a, b] = await Promise.all([ask(user, id), ask(user, id)]);
    expect((a.json() as { id: string }).id).toBe((b.json() as { id: string }).id);
    expect((await settled(user, id)).failure).toBe('unreachable');
    // The DGX was unreachable three more times: none of that used the owner's tries.
    for (let i = 0; i < 3; i += 1) {
      expect((await ask(user, id)).statusCode).toBe(202);
      await settled(user, id);
    }
    setAligner(answering({ status: 'ok', timings: { source: 'aligned', aligner: 'spark-whisper', lines: LINES } }));
    expect((await ask(user, id)).statusCode).toBe(202);
    expect((await settled(user, id)).status).toBe('ready');
  }, 60_000);

  it('picks up a request left queued (a pod roll) when the page next asks how it is going', async () => {
    const user = await h.createUser({ credits: 5 });
    const id = await song(user);
    setAligner(answering({ status: 'ok', timings: { source: 'aligned', aligner: 'spark-whisper', lines: LINES } }));
    // Queued by a process that then went away: nobody is draining it.
    await insertLyricProposal({ trackId: id, ownerId: user.id, lyricsSha: createHash('sha256').update(LYRICS, 'utf8').digest('hex') });
    expect((await settled(user, id)).status).toBe('ready');
  }, 60_000);

  it('stays off until switched on, aligner or not: the DGX must take sent audio first', async () => {
    const user = await off.createUser({ credits: 5 });
    const res = await off.app.inject({
      method: 'POST',
      url: '/v1/generations',
      headers: { ...user.authHeader, 'idempotency-key': `prop-${randomUUID()}` },
      payload: { mode: 'custom', prompt: 'a quiet walk', styles: ['chill'], instrumental: false, durationSeconds: 30, lyrics: LYRICS } as never,
    });
    expect(res.statusCode).toBe(202);
    (off.ctx as { alignment: AlignmentProvider }).alignment = answering({ status: 'failed', reason: 'x' });
    expect((await off.app.inject({ method: 'GET', url: '/v1/runtime' })).json().features.lyricAutoAlign).toBe(false);
    // Asked anyway: refused for every song, so the route says nothing about whose it is.
    const ask = await off.app.inject({ method: 'POST', url: `/v1/tracks/${randomUUID()}/lyric-proposal`, headers: user.authHeader });
    expect(ask.statusCode).toBe(503);
  });

  it('is counted in the console: asked, answered, heard too little, failed otherwise', async () => {
    const user = await h.createUser({ credits: 10 });
    const a = await song(user);
    const b = await song(user);
    const c = await song(user);
    setAligner(answering({ status: 'ok', timings: { source: 'aligned', aligner: 'spark-whisper', lines: LINES } }));
    await ask(user, a);
    await settled(user, a);
    setAligner(answering({ status: 'ok', timings: { source: 'estimated', aligner: 'estimated-v1', lines: LINES }, fallbackReason: 'aligner_http_422 low_coverage coverage=0.2' }));
    await ask(user, b);
    await settled(user, b);
    setAligner(answering({ status: 'failed', reason: 'aligner_timeout' }));
    await ask(user, c);
    await settled(user, c);
    const report = await qualityReport({ hours: 24 });
    expect(report.lyricProposals).toEqual({ asked: 3, aligned: 1, heardTooLittle: 1, failed: 1 });
  }, 60_000);

  it('is offered by the runtime only where a real aligner is configured', async () => {
    setAligner(original); // the test stack's estimator
    expect((await h.app.inject({ method: 'GET', url: '/v1/runtime' })).json().features.lyricAutoAlign).toBe(false);
    setAligner(answering({ status: 'failed', reason: 'x' }));
    expect((await h.app.inject({ method: 'GET', url: '/v1/runtime' })).json().features.lyricAutoAlign).toBe(true);
  });
});
