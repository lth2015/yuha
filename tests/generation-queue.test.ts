import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { claimJobById, getBalance, getJob, listStaleUnknownJobs, query, withTx } from '@yuha/db';
import { HttpMusicProvider, httpMusicProviderConfig } from '@yuha/providers';
import { runJobStep } from '@yuha/worker/pipeline';
import { createHarness, resetData, teardown, type Harness } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => { h = await createHarness({ ADMIN_MFA_REQUIRED: 'false' }); });
beforeEach(resetData);
afterAll(async () => { await h?.close(); await teardown(); });
const log = () => undefined;
const request = { mode: 'simple', prompt: 'quiet rain and piano', styles: ['ambient'], instrumental: true, energy: 0.3, durationSeconds: 30 };
async function createJob() {
  const user = await h.createUser({ credits: 3 });
  const response = await h.app.inject({ method: 'POST', url: '/v1/generations', headers: { ...user.authHeader, 'idempotency-key': `queue-${user.id}` }, payload: request });
  expect(response.statusCode, response.body).toBe(202);
  return { user, jobId: response.json().jobId as string };
}

describe('a shared GPU has a durable waiting line', () => {
  it('handles a community arrival burst without exceeding one GPU or losing cancellation credits', async () => {
    const music = h.ctx.music;
    let submissions = 0;
    h.ctx.music = {
      capabilities: () => ({ ...music.capabilities(), maxConcurrency: 1 }),
      submit: async () => { submissions++; return { status: 'submitted', providerRequestId: 'burst-running' }; },
      poll: async () => ({ status: 'failed', code: 'render_failed', message: 'fixture failure' }),
    };
    try {
      const visitors = await Promise.all(Array.from({ length: 12 }, () => createJob()));
      await Promise.all(visitors.map(({ jobId }, index) => runJobStep({ ctx: h.ctx, owner: `burst-worker-${index}`, log }, jobId)));
      expect(submissions).toBe(1);
      const views = await Promise.all(visitors.map(async ({ user, jobId }) => {
        const response = await h.app.inject({ method: 'GET', url: `/v1/jobs/${jobId}`, headers: user.authHeader });
        expect(response.statusCode).toBe(200);
        return response.json();
      }));
      expect(views.filter((job) => job.state === 'SUBMITTED')).toHaveLength(1);
      expect(views.filter((job) => job.state === 'QUEUED').map((job) => job.queuePosition).sort((a, b) => a - b))
        .toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      await Promise.all(visitors.map(async ({ user, jobId }, index) => {
        if (views[index].state === 'QUEUED') {
          const cancel = await h.app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/cancel`, headers: user.authHeader });
          expect(cancel.json()).toMatchObject({ cancelled: true });
        } else await runJobStep({ ctx: h.ctx, owner: 'burst-finish', log }, jobId);
        const balance = await h.app.inject({ method: 'GET', url: '/v1/entitlements', headers: user.authHeader });
        expect(balance.json()).toMatchObject({ availableUnits: 3, reservedUnits: 0 });
      }));
    } finally { h.ctx.music = music; }
  });

  it('submits only one song across users and workers when capacity is one', async () => {
    const demo = h.ctx.music;
    let submissions = 0;
    h.ctx.music = {
      capabilities: () => ({ ...demo.capabilities(), maxConcurrency: 1 }),
      submit: async () => { submissions++; return { status: 'submitted', providerRequestId: 'gpu-1' }; },
      poll: async () => ({ status: 'pending' }),
    };
    try {
      const first = await createJob();
      const second = await createJob();
      await Promise.all([
        runJobStep({ ctx: h.ctx, owner: 'worker-a', log }, first.jobId),
        runJobStep({ ctx: h.ctx, owner: 'worker-b', log }, second.jobId),
      ]);
      expect(submissions).toBe(1);
      expect((await getJob(first.jobId))?.state).toBe('SUBMITTED');
      const waiting = await h.app.inject({ method: 'GET', url: `/v1/jobs/${second.jobId}`, headers: second.user.authHeader });
      expect(waiting.json().state).toBe('QUEUED');
      expect(waiting.json().queuePosition).toBe(2);
      expect(await getBalance(second.user.id)).toMatchObject({ available: 2, reserved: 1 });
      // A failed upstream job frees the single slot, then the next user proceeds.
      h.ctx.music.poll = async () => ({ status: 'failed', code: 'render_failed', message: 'fixture failure' });
      await runJobStep({ ctx: h.ctx, owner: 'worker-a', log }, first.jobId);
      await query('UPDATE generation_jobs SET next_run_at = NULL WHERE id = ?', [second.jobId]);
      await runJobStep({ ctx: h.ctx, owner: 'worker-b', log }, second.jobId);
      expect(submissions).toBe(2);
      expect((await getJob(second.jobId))?.state).toBe('SUBMITTED');
      expect(await getBalance(first.user.id)).toMatchObject({ available: 3, reserved: 0 });
    } finally { h.ctx.music = demo; }
  });
  it('keeps an HTTP 429 in the waiting line after verifying it was not accepted', async () => {
    const demo = h.ctx.music;
    const realFetch = globalThis.fetch;
    const caps = demo.capabilities();
    h.ctx.music = new HttpMusicProvider(httpMusicProviderConfig.parse({
      ...caps, baseUrl: 'https://music.example.test', apiKey: 'test-key',
      submitPath: '/v1/jobs', pollPath: '/v1/jobs/{id}', idempotencyHeader: 'Idempotency-Key',
      requestIdField: 'id', statusField: 'status', audioUrlField: 'audio_url',
      statusMap: { pending: ['queued'], completed: ['succeeded'], failed: ['failed'], rejected: ['rejected'] },
      allowedAudioHosts: ['music.example.test'],
    }));
    const keys: string[] = [];
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      if (init.method === 'POST') {
        keys.push((init.headers as Record<string, string>)['Idempotency-Key']!);
        return new Response(JSON.stringify({ error: 'queue_full' }), { status: 429 });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
    try {
      const { user, jobId } = await createJob();
      const deps = { ctx: h.ctx, owner: 'worker', log };
      await runJobStep(deps, jobId);
      expect((await getJob(jobId))?.state).toBe('UNKNOWN');
      await query('UPDATE generation_jobs SET verify_started_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 20 MINUTE) WHERE id = ?', [jobId]);
      await runJobStep(deps, jobId);
      expect((await getJob(jobId))?.state).toBe('QUEUED');
      expect(await getBalance(user.id)).toMatchObject({ available: 2, reserved: 1 });
      // Backoff is durable: repeated steps cannot hammer the GPU.
      await runJobStep(deps, jobId);
      expect(keys).toHaveLength(1);
      await query('UPDATE generation_jobs SET next_run_at = NULL WHERE id = ?', [jobId]);
      await runJobStep(deps, jobId);
      expect(keys).toEqual([keys[0], keys[0]]);
      expect((await listStaleUnknownJobs(900)).map((job) => job.id)).not.toContain(jobId);
      const costs = await query<{ n: number }>("SELECT COUNT(*) AS n FROM provider_cost_events WHERE job_id = ? AND provider_kind = 'text'", [jobId]);
      expect(Number(costs[0]?.n)).toBe(1);
    } finally { globalThis.fetch = realFetch; h.ctx.music = demo; }
  });

  it('releases the credit when waiting exceeds the queue deadline', async () => {
    const { user, jobId } = await createJob();
    await query('UPDATE generation_jobs SET created_at = DATE_SUB(UTC_TIMESTAMP(3), INTERVAL 2 HOUR) WHERE id = ?', [jobId]);
    await runJobStep({ ctx: h.ctx, owner: 'worker', log }, jobId);
    const response = await h.app.inject({ method: 'GET', url: `/v1/jobs/${jobId}`, headers: user.authHeader });
    expect(response.json()).toMatchObject({ state: 'FAILED', errorCode: 'queue_wait_timeout' });
    expect(await getBalance(user.id)).toMatchObject({ available: 3, reserved: 0 });
  });

  it('shows operators failure categories without counting queued jobs as completed', async () => {
    const demo = h.ctx.music;
    h.ctx.music = { capabilities: () => demo.capabilities(), submit: async () => ({ status: 'failed', providerRequestId: null, code: 'gpu_oom', message: 'fixture failure' }), poll: async () => ({ status: 'pending' }) };
    try {
      const failed = await createJob();
      await runJobStep({ ctx: h.ctx, owner: 'worker', log }, failed.jobId);
      await createJob();
      const admin = await h.createUser({ role: 'admin' });
      const response = await h.app.inject({ method: 'GET', url: '/v1/admin/overview', headers: admin.authHeader });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().operations.generationFailures).toEqual([
        { code: 'upstream_failed', state: 'FAILED', count: 1 },
      ]);
      expect(response.json().operations.technicalSuccessRate).toMatchObject({ n: 1, value: 0 });
    } finally { h.ctx.music = demo; }
  });

  it('backs off pending status reads instead of polling the GPU continuously', async () => {
    const demo = h.ctx.music;
    let polls = 0;
    h.ctx.music = { capabilities: () => demo.capabilities(), submit: async () => ({ status: 'submitted', providerRequestId: 'running' }), poll: async () => { polls++; return { status: 'pending' }; } };
    try {
      const { jobId } = await createJob();
      const deps = { ctx: h.ctx, owner: 'worker', log };
      await runJobStep(deps, jobId);
      await runJobStep(deps, jobId);
      await runJobStep(deps, jobId);
      await runJobStep(deps, jobId);
      expect(polls).toBe(1);
    } finally { h.ctx.music = demo; }
  });

  it('does not free GPU capacity when cancellation races an in-flight submit', async () => {
    const demo = h.ctx.music;
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let submissions = 0;
    h.ctx.music = { capabilities: () => ({ ...demo.capabilities(), maxConcurrency: 1 }),
      submit: async () => { submissions++; entered(); await barrier; return { status: 'submitted', providerRequestId: 'gpu-running' }; },
      poll: async () => ({ status: 'pending' }) };
    const first = await createJob();
    const second = await createJob();
    const running = runJobStep({ ctx: h.ctx, owner: 'worker-a', log }, first.jobId);
    try {
      await started;
      const cancel = await h.app.inject({ method: 'POST', url: `/v1/jobs/${first.jobId}/cancel`, headers: first.user.authHeader });
      expect(cancel.json().cancelled).toBe(false);
      await runJobStep({ ctx: h.ctx, owner: 'worker-b', log }, second.jobId);
      expect(submissions).toBe(1);
      expect(await getBalance(first.user.id)).toMatchObject({ available: 2, reserved: 1 });
    } finally { release(); await running; h.ctx.music = demo; }
  });

  it('honours a cancellation received during text generation before calling the GPU', async () => {
    const music = h.ctx.music;
    const text = h.ctx.text;
    let release!: () => void;
    let entered!: () => void;
    const barrier = new Promise<void>((r) => { release = r; });
    const started = new Promise<void>((r) => { entered = r; });
    let submissions = 0;
    h.ctx.text = { providerId: text.providerId, model: text.model,
      extractIntent: async (req) => { entered(); await barrier; return text.extractIntent(req); } };
    h.ctx.music = { capabilities: () => music.capabilities(), submit: async () => { submissions++; return { status: 'submitted', providerRequestId: 'unused' }; }, poll: async () => ({ status: 'pending' }) };
    const { user, jobId } = await createJob();
    const running = runJobStep({ ctx: h.ctx, owner: 'worker', log }, jobId);
    try {
      await started;
      const response = await h.app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/cancel`, headers: user.authHeader });
      expect(response.json().cancelled).toBe(false); // The worker acknowledges after leaving the model call.
      release(); await running;
      expect(submissions).toBe(0);
      expect((await getJob(jobId))?.state).toBe('CANCELLED');
      expect(await getBalance(user.id)).toMatchObject({ available: 3, reserved: 0 });
    } finally { release(); await running; h.ctx.music = music; h.ctx.text = text; }
  });

  it('does not let an unsuccessful cancellation bypass a pending poll interval', async () => {
    const music = h.ctx.music;
    h.ctx.music = { capabilities: () => music.capabilities(), submit: async () => ({ status: 'submitted', providerRequestId: 'running' }), poll: async () => ({ status: 'pending' }) };
    try {
      const { user, jobId } = await createJob();
      const deps = { ctx: h.ctx, owner: 'worker-a', log };
      await runJobStep(deps, jobId); await runJobStep(deps, jobId);
      const cancel = await h.app.inject({ method: 'POST', url: `/v1/jobs/${jobId}/cancel`, headers: user.authHeader });
      expect(cancel.json().cancelled).toBe(false);
      expect(await withTx((tx) => claimJobById({ jobId, owner: 'worker-b', leaseSeconds: 90 }, tx))).toBeUndefined();
      expect((await getJob(jobId))?.lease_owner).toBeNull();
    } finally { h.ctx.music = music; }
  });

});
