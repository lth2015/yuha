/**
 * What the error messages promise, read from the ledger
 * (CLAUDE.md: "No credit spent" → read the ledger).
 *
 * Every refusal a person can meet when asking for a song says, in
 * apps/web/src/lib/i18n.tsx, that no credit was spent. Each case here makes
 * the API refuse in that way and then looks: no reservation, no job, the
 * balance where it was.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execute, query, setSetting } from '@yuha/db';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

let h: Harness;
beforeAll(async () => {
  // The harness allows ten at once; production allows two.
  h = await createHarness({ MAX_CONCURRENT_JOBS_PER_USER: '2' });
});
beforeEach(async () => {
  await resetData();
});
afterAll(async () => {
  await h?.close();
  await teardown();
});

const ask = (user: TestUser, payload: Record<string, unknown> = { mode: 'simple', prompt: '雨の日の駅', instrumental: true, durationSeconds: 30 }) =>
  h.app.inject({
    method: 'POST',
    url: '/v1/generations',
    headers: { ...user.authHeader, 'idempotency-key': `p-${randomUUID()}` },
    payload: payload as never,
  });

async function spentNothing(user: TestUser, jobsBefore: number) {
  const reserves = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM ledger_entries WHERE user_id = ? AND entry_type IN ('reserve','consume')`, [user.id]);
  const jobs = await query<{ n: number }>(`SELECT COUNT(*) AS n FROM generation_jobs WHERE user_id = ?`, [user.id]);
  const balance = (await h.app.inject({ method: 'GET', url: '/v1/entitlements', headers: user.authHeader })).json();
  return { reserves: Number(reserves[0]!.n), newJobs: Number(jobs[0]!.n) - jobsBefore, reserved: balance.reservedUnits };
}

describe('a refused song costs nothing', () => {
  it('RATE_LIMITED: too many at once', async () => {
    const u = await h.createUser({ credits: 5 });
    expect((await ask(u)).statusCode).toBe(202);
    expect((await ask(u)).statusCode).toBe(202);
    const before = await spentNothing(u, 0);
    const res = await ask(u);
    expect(res.json().error.code).toBe('RATE_LIMITED');
    expect(await spentNothing(u, 2)).toEqual({ ...before, newJobs: 0 });
  });

  it('BUDGET_EXCEEDED: the day’s provider budget is gone', async () => {
    const u = await h.createUser({ credits: 2 });
    await execute(
      `INSERT INTO provider_cost_events (id, job_id, attempt_id, provider_id, provider_kind, event_type, billable, cost_minor, is_estimate, contract_version, usage_data, occurred_at)
       VALUES (?, NULL, NULL, 'demo', 'music', 'success', 1, ?, 1, 'v', '{}', UTC_TIMESTAMP(3))`,
      [randomUUID(), h.ctx.config.DAILY_BUDGET_MINOR + 1],
    );
    const res = await ask(u);
    expect(res.json().error.code).toBe('BUDGET_EXCEEDED');
    expect(await spentNothing(u, 0)).toEqual({ reserves: 0, newJobs: 0, reserved: 0 });
  });

  it('SERVICE_DISABLED: generation paused by an operator', async () => {
    const u = await h.createUser({ credits: 2 });
    await setSetting({ key: 'feature_overrides', value: { generationEnabled: false }, updatedBy: null, reason: 'test: paused' });
    try {
      const res = await ask(u);
      expect(res.json().error.code).toBe('SERVICE_DISABLED');
      expect(await spentNothing(u, 0)).toEqual({ reserves: 0, newJobs: 0, reserved: 0 });
    } finally {
      await setSetting({ key: 'feature_overrides', value: {}, updatedBy: null, reason: 'test: resumed' });
    }
  });

  it('INSUFFICIENT_CREDITS: nothing to spend', async () => {
    const u = await h.createUser({ credits: 0 });
    const res = await ask(u);
    expect(res.json().error.code).toBe('INSUFFICIENT_CREDITS');
    const after = await spentNothing(u, 0);
    expect(after.reserves).toBe(0);
    expect(after.reserved).toBe(0);
  });

  it('PROMPT_BLOCKED: words that cannot be used', async () => {
    const u = await h.createUser({ credits: 2 });
    const res = await ask(u, { mode: 'simple', prompt: 'あの歌手の声を真似して歌って', instrumental: true, durationSeconds: 30 });
    expect(res.json().error.code).toBe('PROMPT_BLOCKED');
    expect(await spentNothing(u, 0)).toEqual({ reserves: 0, newJobs: 0, reserved: 0 });
  });
});
