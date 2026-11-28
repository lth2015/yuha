// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { claimPendingTrial, guestSongId, hasPendingTrial } from '../apps/web/src/lib/guest.js';

const songId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
beforeEach(() => {
  localStorage.setItem('yuha.guest', 'fixture-guest-token');
  localStorage.setItem('yuha.guest-song', songId);
});
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

it('keeps a trial and its song link after an HTTP 503, then claims it on retry', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockResolvedValueOnce(Response.json({ error: { code: 'INTERNAL_ERROR' } }, { status: 503 }))
    .mockResolvedValueOnce(Response.json({ claimed: 1 })));
  expect(await claimPendingTrial()).toBe('retry');
  expect(hasPendingTrial()).toBe(true);
  expect(guestSongId()).toBe(songId);
  expect(await claimPendingTrial()).toBe('claimed');
  expect(hasPendingTrial()).toBe(false);
  expect(guestSongId()).toBeNull();
});

it('reports success if the account already claimed the song and retries after a lost response', async () => {
  vi.stubGlobal('fetch', vi.fn()
    .mockRejectedValueOnce(new TypeError('network unreachable'))
    .mockResolvedValueOnce(Response.json({ claimed: 0, alreadyClaimed: true })));
  expect(await claimPendingTrial()).toBe('retry');
  expect(guestSongId()).toBe(songId);
  expect(await claimPendingTrial()).toBe('claimed');
  expect(hasPendingTrial()).toBe(false);
});

it.each([204, 200])('keeps the claim when an unexpected %d response has no receipt', async (status) => {
  const response = status === 204 ? new Response(null, { status }) : Response.json(null);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
  expect(await claimPendingTrial()).toBe('retry');
  expect(hasPendingTrial()).toBe(true);
  expect(guestSongId()).toBe(songId);
});

it.each([[404, 'NOT_FOUND'], [409, 'CONFLICT']] as const)(
  'clears the trial only when the API confirms it cannot be claimed (%d)',
  async (status, code) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ error: { code } }, { status })));
    expect(await claimPendingTrial()).toBe('gone');
    expect(hasPendingTrial()).toBe(false);
    expect(guestSongId()).toBeNull();
  },
);
