/**
 * Generation API and worker pipeline: GEN-01, GEN-02, GEN-03, GEN-04, GEN-05,
 * GEN-06, GEN-07, GEN-08, GEN-10, GEN-12, plus the AI-* input rules.
 *
 * These drive the real HTTP surface and the real worker step function, so a
 * pass here means the whole path — reservation, queueing, provider call, output
 * check, delivery — behaved, not just one unit.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  claimOutboxBatch,
  getBalance,
  getJob,
  listAssets,
  query,
  withTx,
  type JobRow,
} from '@loopscene/db';
import { runJobStep } from '@loopscene/worker/pipeline';
import { createHarness, ledgerFor, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await h.close();
  await teardown();
});

const log = () => undefined;

async function post(user: TestUser, body: unknown, idempotencyKey: string) {
  return h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': idempotencyKey },
    payload: body as never,
  });
}

const defaultBody = {
  mode: 'simple' as const,
  prompt: 'a quiet late-night walk, gentle rain',
  styles: ['chill'],
  instrumental: true,
  energy: 0.3,
  durationSeconds: 30,
};

/** Drains the outbox onto the queue, exactly as the worker's dispatcher does. */
async function dispatchOutbox(): Promise<number> {
  const rows = await withTx(async (tx) => claimOutboxBatch(50, tx));
  for (const row of rows) {
    await h.ctx.queue.send({ body: { ...row.payload, outboxId: row.id, eventType: row.event_type } });
  }
  return rows.length;
}

/** Runs the worker until the job reaches a terminal state, or the budget runs out. */
async function runToCompletion(jobId: string, maxSteps = 6): Promise<JobRow> {
  for (let i = 0; i < maxSteps; i += 1) {
    const job = await getJob(jobId);
    if (!job) throw new Error('job vanished');
    if (['DELIVERED', 'FAILED', 'REJECTED', 'CANCELLED'].includes(job.state)) return job;
    await runJobStep({ ctx: h.ctx, owner: `test-${i}`, log }, jobId);
  }
  return (await getJob(jobId))!;
}

describe('POST /v1/generations', () => {
  it('reserves a credit and returns 202 with a job id', async () => {
    const user = await h.createUser({ credits: 3 });
    const res = await post(user, defaultBody, 'key-basic');

    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.state).toBe('QUEUED');
    expect(body.deduplicated).toBe(false);

    const balance = await getBalance(user.id);
    expect(balance).toMatchObject({ available: 2, reserved: 1 });
  });

  it('GEN-01: replaying the same key with the same body returns the same job', async () => {
    const user = await h.createUser({ credits: 3 });
    const first = await post(user, defaultBody, 'key-replay');
    const second = await post(user, defaultBody, 'key-replay');

    expect(second.statusCode).toBe(202);
    expect(second.json().jobId).toBe(first.json().jobId);
    expect(second.json().deduplicated).toBe(true);

    // Exactly one reservation, and only one job row.
    expect(await ledgerFor(first.json().jobId)).toEqual([{ entry_type: 'reserve', units: 1 }]);
    expect((await getBalance(user.id)).available).toBe(2);
  });

  it('GEN-01: concurrent submissions with the same key produce one job and one reservation', async () => {
    const user = await h.createUser({ credits: 5 });
    const results = await Promise.all(
      Array.from({ length: 5 }, () => post(user, defaultBody, 'key-concurrent')),
    );

    const ids = new Set(results.filter((r) => r.statusCode === 202).map((r) => r.json().jobId));
    expect(ids.size).toBe(1);

    const balance = await getBalance(user.id);
    expect(balance.reserved).toBe(1);
    expect(balance.available).toBe(4);
  });

  it('GEN-02: the same key with different content is a conflict and changes nothing', async () => {
    const user = await h.createUser({ credits: 3 });
    const first = await post(user, defaultBody, 'key-conflict');
    const second = await post(user, { ...defaultBody, styles: ['trap'], energy: 0.9 }, 'key-conflict');

    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('IDEMPOTENCY_KEY_REUSED');

    // The original job is untouched and no second credit was taken.
    const job = await getJob(first.json().jobId);
    expect((job!.input as { styles: string[] }).styles).toEqual(['chill']);
    expect((await getBalance(user.id)).available).toBe(2);
  });

  it('GEN-03: with one credit left, only one of two different jobs is accepted', async () => {
    const user = await h.createUser({ credits: 1 });
    const [a, b] = await Promise.all([post(user, defaultBody, 'race-key-a'), post(user, defaultBody, 'race-key-b')]);

    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([202, 402]);

    const rejected = [a, b].find((r) => r.statusCode === 402)!;
    expect(rejected.json().error.code).toBe('INSUFFICIENT_CREDITS');

    const balance = await getBalance(user.id);
    expect(balance.available).toBe(0);
    expect(balance.available).toBeGreaterThanOrEqual(0);
  });

  it('a rejected reservation leaves no orphan job row', async () => {
    const user = await h.createUser({ credits: 0 });
    const res = await post(user, defaultBody, 'key-nocredit');

    expect(res.statusCode).toBe(402);
    const rows = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM generation_jobs WHERE user_id = ?`,
      [user.id],
    );
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it('requires an idempotency key', async () => {
    const user = await h.createUser({ credits: 3 });
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/generations',
      headers: user.authHeader,
      payload: defaultBody as never,
    });
    expect(res.statusCode).toBe(400);
  });

  it('AI-03: a prompt over 500 code points is refused before any spend', async () => {
    const user = await h.createUser({ credits: 3 });
    const res = await post(user, { ...defaultBody, prompt: 'あ'.repeat(501) }, 'key-long');

    expect(res.statusCode).toBe(400);
    expect((await getBalance(user.id)).available).toBe(3);
  });

  it('SEC-07: blocked input costs no credit and is reported as appealable', async () => {
    const user = await h.createUser({ credits: 3 });
    // Requesting vocals is fine now; imitating a real person's voice is not.
    const res = await post(user, { ...defaultBody, prompt: 'あの歌手の声を真似して歌って' }, 'key-blocked');

    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('PROMPT_BLOCKED');
    expect(res.json().error.details.reason).toBe('voice_imitation');
    // A block is "outside what we accept", not an accusation — and it is contestable.
    expect(res.json().error.details.appealable).toBe(true);
    expect((await getBalance(user.id)).available).toBe(3);
  });

  it('SEC-05: a reference-media URL in the prompt is refused', async () => {
    const user = await h.createUser({ credits: 3 });
    const res = await post(user, { ...defaultBody, prompt: 'https://example.com/song.mp3 みたいな曲' }, 'key-url-block');

    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.reason).toBe('reference_media_url');
  });
});

describe('worker pipeline', () => {
  it('delivers a track, consumes exactly one credit and freezes a licence record', async () => {
    const user = await h.createUser({ credits: 2 });
    const { jobId } = (await post(user, defaultBody, 'key-deliver')).json();

    const job = await runToCompletion(jobId);
    expect(job.state).toBe('DELIVERED');
    expect(job.track_id).not.toBeNull();

    const balance = await getBalance(user.id);
    expect(balance).toMatchObject({ available: 1, reserved: 0, consumed: 1 });
    expect((await ledgerFor(jobId)).map((e) => e.entry_type)).toEqual(['reserve', 'consume']);

    // The master exists and the licence snapshot was written with the audio hash.
    const assets = await listAssets(job.track_id!);
    expect(assets.filter((a) => a.kind === 'master')).toHaveLength(1);

    const licence = await query<{ source_sha256: string; commercial_delivery: boolean }>(
      `SELECT source_sha256, commercial_delivery FROM license_snapshots WHERE track_id = ?`,
      [job.track_id],
    );
    expect(licence[0]!.source_sha256).toHaveLength(64);
    // Demo mode has no signed agreement, so commercial delivery stays off (SEC-09).
    expect(licence[0]!.commercial_delivery).toBe(false);
  });

  it('GEN-08: running the pipeline again after delivery changes nothing', async () => {
    const user = await h.createUser({ credits: 2 });
    const { jobId } = (await post(user, defaultBody, 'key-twice')).json();
    await runToCompletion(jobId);

    const before = await getBalance(user.id);
    await runJobStep({ ctx: h.ctx, owner: 'test-again', log }, jobId);
    await runJobStep({ ctx: h.ctx, owner: 'test-again-2', log }, jobId);

    expect(await getBalance(user.id)).toEqual(before);
    expect((await ledgerFor(jobId)).filter((e) => e.entry_type === 'consume')).toHaveLength(1);
  });

  it('GEN-04: a duplicated queue message does not produce a second charge', async () => {
    const user = await h.createUser({ credits: 2 });
    const { jobId } = (await post(user, defaultBody, 'key-dup-msg')).json();

    await dispatchOutbox();
    // Simulate SQS at-least-once: the same message delivered twice.
    await h.ctx.queue.send({ body: { jobId, userId: user.id } });

    await runToCompletion(jobId);
    await runJobStep({ ctx: h.ctx, owner: 'dup', log }, jobId);

    expect((await getBalance(user.id)).consumed).toBe(1);
    expect((await ledgerFor(jobId)).filter((e) => e.entry_type === 'consume')).toHaveLength(1);
  });

  it('GEN-07: a provider rejection releases the credit and is not downloadable', async () => {
    const user = await h.createUser({ credits: 2 });
    // The fault marker travels in the brief, so the production code path runs.
    const { jobId } = (await post(user, { ...defaultBody, prompt: '__FAULT_REJECT__' }, 'key-reject')).json();

    const job = await runToCompletion(jobId);
    expect(job.state).toBe('REJECTED');
    expect(job.track_id).toBeNull();

    // Released, not consumed: a provider rejection is not the user's fault.
    expect(await getBalance(user.id)).toMatchObject({ available: 2, consumed: 0 });
    expect((await ledgerFor(jobId)).map((e) => e.entry_type)).toEqual(['reserve', 'release']);
  });

  it('GEN-07: a technical failure releases the credit', async () => {
    const user = await h.createUser({ credits: 2 });
    const { jobId } = (await post(user, { ...defaultBody, prompt: '__FAULT_FAIL__' }, 'key-fail')).json();

    const job = await runToCompletion(jobId);
    expect(job.state).toBe('FAILED');
    expect(await getBalance(user.id)).toMatchObject({ available: 2, consumed: 0 });
  });

  it('AI-06: a billable failure still records the upstream cost', async () => {
    const user = await h.createUser({ credits: 2 });
    const { jobId } = (await post(user, { ...defaultBody, prompt: '__FAULT_FAIL__' }, 'key-cost')).json();
    await runToCompletion(jobId);

    const costs = await query<{ event_type: string; billable: boolean; is_estimate: boolean; cost_minor: number }>(
      `SELECT event_type, billable, is_estimate, cost_minor FROM provider_cost_events
        WHERE job_id = ? AND provider_kind = 'music'`,
      [jobId],
    );
    expect(costs.length).toBeGreaterThan(0);
    // The demo adapter's contract says failures are billable, so the platform
    // records the cost it bore even though the user was not charged.
    expect(costs[0]!.billable).toBe(true);
    expect(costs[0]!.cost_minor).toBeGreaterThan(0);
    // And it is flagged as a modelled figure, not a supplier invoice.
    expect(costs[0]!.is_estimate).toBe(true);
  });

  it('GEN-06: an ambiguous submission enters UNKNOWN rather than resubmitting', async () => {
    const user = await h.createUser({ credits: 2 });
    const { jobId } = (await post(user, { ...defaultBody, prompt: '__FAULT_UNKNOWN__' }, 'key-unknown')).json();

    await runJobStep({ ctx: h.ctx, owner: 'w1', log }, jobId);
    const job = await getJob(jobId);
    expect(job!.state).toBe('UNKNOWN');
    expect(job!.verify_started_at).not.toBeNull();

    // Still reserved: the outcome is genuinely unknown, so neither charging nor
    // refunding is correct yet.
    expect(await getBalance(user.id)).toMatchObject({ reserved: 1, consumed: 0 });

    // Verification queries the upstream by the stable key and finds the work
    // did land, so it completes without a second submission.
    const final = await runToCompletion(jobId);
    expect(final.state).toBe('DELIVERED');

    const attempts = await query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM generation_attempts WHERE job_id = ?`,
      [jobId],
    );
    expect(Number(attempts[0]!.n)).toBe(1);
    expect((await getBalance(user.id)).consumed).toBe(1);
  });

  it('GEN-12: cancelling before submission refunds; the UI is not told "cancelled" otherwise', async () => {
    const user = await h.createUser({ credits: 2 });
    const { jobId } = (await post(user, defaultBody, 'key-cancel')).json();

    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/cancel`,
      headers: user.authHeader,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().cancelled).toBe(true);
    expect(res.json().state).toBe('CANCELLED');

    expect(await getBalance(user.id)).toMatchObject({ available: 2, consumed: 0, reserved: 0 });

    // The worker must not resurrect a cancelled job.
    await runJobStep({ ctx: h.ctx, owner: 'after-cancel', log }, jobId);
    expect((await getJob(jobId))!.state).toBe('CANCELLED');
  });

  it('GEN-12: cancelling a delivered job is refused rather than silently accepted', async () => {
    const user = await h.createUser({ credits: 2 });
    const { jobId } = (await post(user, defaultBody, 'key-late-cancel')).json();
    await runToCompletion(jobId);

    const res = await h.app.inject({
      method: 'POST',
      url: `/v1/jobs/${jobId}/cancel`,
      headers: user.authHeader,
    });
    expect(res.statusCode).toBe(409);
    expect((await getBalance(user.id)).consumed).toBe(1);
  });

  it('GEN-10: an in-flight job is recoverable from persisted state after a "reload"', async () => {
    const user = await h.createUser({ credits: 2 });
    const { jobId } = (await post(user, defaultBody, 'key-reload')).json();

    // A fresh request with a fresh token — as if the browser had been closed.
    const open = await h.app.inject({ method: 'GET', url: '/v1/jobs', headers: user.authHeader });
    expect(open.statusCode).toBe(200);
    expect(open.json().items.map((j: { jobId: string }) => j.jobId)).toContain(jobId);

    await runToCompletion(jobId);
    const after = await h.app.inject({ method: 'GET', url: '/v1/jobs', headers: user.authHeader });
    expect(after.json().items).toHaveLength(0);
  });

  it('GEN-05: a lease expiring after a crash lets another worker finish the job', async () => {
    const user = await h.createUser({ credits: 2 });
    const { jobId } = (await post(user, defaultBody, 'key-crash')).json();

    // Simulate a worker that claimed the job and then died mid-flight.
    await query(
      `UPDATE generation_jobs
          SET lease_owner = 'dead-worker',
              lease_expires_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 5 MINUTE)
        WHERE id = ?`,
      [jobId],
    );

    const job = await runToCompletion(jobId);
    expect(job.state).toBe('DELIVERED');
    expect((await ledgerFor(jobId)).filter((e) => e.entry_type === 'consume')).toHaveLength(1);
  });

  it('the outbox is written in the same transaction as the reservation', async () => {
    const user = await h.createUser({ credits: 2 });
    const { jobId } = (await post(user, defaultBody, 'key-outbox')).json();

    const rows = await query<{ aggregate_id: string; event_type: string; status: string }>(
      `SELECT aggregate_id, event_type, status FROM outbox WHERE aggregate_id = ?`,
      [jobId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.event_type).toBe('generation.requested');
  });
});

describe('capability honesty (AI-05)', () => {
  it('only advertises the durations the configured provider supports', async () => {
    const caps = h.ctx.music.capabilities();
    expect(caps.supportedDurationsSeconds).toContain(30);
    expect(caps.supportsInstrumentalOnly).toBe(true);
  });

  it('re-imposes the creator\'s vocal and duration choices server side, not trusting the model', async () => {
    const user = await h.createUser({ credits: 2 });
    const { jobId } = (
      await post(user, { ...defaultBody, instrumental: false, durationSeconds: 120, mode: 'custom', lyrics: '[Verse]\nlo-fi hearts\n[Chorus]\nslow down' }, 'key-instrumental')
    ).json();
    await runToCompletion(jobId);

    const job = await getJob(jobId);
    expect((job!.resolved_params as { vocalMode: string }).vocalMode).toBe('with_vocals');
    expect((job!.resolved_params as { durationSeconds: number }).durationSeconds).toBe(120);
    expect((job!.resolved_params as { lyrics: string | null }).lyrics).toContain('slow down');
    // The delivered song carries the creator's choices.
    const track = await query<{ vocal_mode: string; duration_ms: number }>(
      `SELECT vocal_mode, duration_ms FROM tracks WHERE job_id = ?`,
      [jobId],
    );
    expect(track[0]!.vocal_mode).toBe('with_vocals');
    expect(track[0]!.duration_ms).toBe(120000);
  });
});
