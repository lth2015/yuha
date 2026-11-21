/**
 * When Christmas and New Year are on (docs/HOLIDAY_SPEC.md), in Japan time,
 * whatever the server's own time zone.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { dedicationBrief, holidayMomentsAt, seasonAt, seasonOfOccasion } from '@yuha/contracts';
import { createHarness, resetData, teardown, type Harness, type TestUser } from './helpers/harness.js';

const jst = (iso: string) => new Date(`${iso}+09:00`);

describe('the season, in Japan time', () => {
  it('starts on 10 December and turns into New Year on the 26th', () => {
    expect(seasonAt(jst('2026-12-09T23:59:59'))).toBeNull();
    expect(seasonAt(jst('2026-12-10T00:00:00'))).toBe('xmas');
    expect(seasonAt(jst('2026-12-25T23:59:59'))).toBe('xmas');
    expect(seasonAt(jst('2026-12-26T00:00:00'))).toBe('newyear');
  });

  it('ends after 7 January', () => {
    expect(seasonAt(jst('2027-01-07T23:59:59'))).toBe('newyear');
    expect(seasonAt(jst('2027-01-08T00:00:00'))).toBeNull();
    expect(seasonAt(jst('2027-03-01T12:00:00'))).toBeNull();
  });

  it('is Japan’s date, not the server’s: 15:30 UTC on the 9th is already the 10th in Tokyo', () => {
    expect(seasonAt(new Date('2026-12-09T15:30:00Z'))).toBe('xmas');
  });
});

describe('the moments', () => {
  it('snows on the 24th and 25th only', () => {
    expect(holidayMomentsAt(jst('2026-12-23T22:00:00'))).toEqual([]);
    expect(holidayMomentsAt(jst('2026-12-24T09:00:00'))).toEqual(['snow']);
    expect(holidayMomentsAt(jst('2026-12-26T00:00:00'))).toEqual([]);
  });

  it('counts down through the last hour and the first ten minutes', () => {
    expect(holidayMomentsAt(jst('2026-12-31T22:59:59'))).toEqual([]);
    expect(holidayMomentsAt(jst('2026-12-31T23:00:00'))).toEqual(['countdown']);
    expect(holidayMomentsAt(jst('2027-01-01T00:09:59'))).toEqual(['countdown', 'new-year-greeting']);
    expect(holidayMomentsAt(jst('2027-01-01T00:10:00'))).toEqual(['new-year-greeting']);
    expect(holidayMomentsAt(jst('2027-01-04T00:00:00'))).toEqual([]);
  });
});

describe('a holiday song', () => {
  it('is dressed by what it is for, not by the date', () => {
    expect(seasonOfOccasion('christmas')).toBe('xmas');
    expect(seasonOfOccasion('new_year')).toBe('newyear');
    expect(seasonOfOccasion('birthday')).toBeNull();
  });

  it('tells the lyric writer the occasion in the creator’s language', () => {
    expect(dedicationBrief({ to: '小林', occasion: 'christmas', lang: 'zh' })).toContain('圣诞');
    expect(dedicationBrief({ to: 'ゆか', occasion: 'new_year', lang: 'ja' })).toContain('新年');
    expect(dedicationBrief({ to: 'Sam', occasion: 'christmas', lang: 'en' })).toContain('Christmas');
  });
});

describe('GET /v1/runtime', () => {
  let h: Harness;
  let admin: TestUser;
  let user: TestUser;
  beforeAll(async () => {
    h = await createHarness();
  });
  beforeEach(async () => {
    await resetData();
    admin = await h.createUser({ email: 'season-admin@example.test', role: 'admin' });
    user = await h.createUser({ email: 'season-user@example.test' });
  });
  afterAll(async () => {
    await h?.close();
    await teardown();
  });

  const runtime = (headers: Record<string, string> = {}, q = '') =>
    h.app.inject({ method: 'GET', url: `/v1/runtime${q}`, headers }).then((r) => r.json());

  it('says the season and the server’s time', async () => {
    const r = await runtime();
    expect(r.season).toBe(seasonAt(new Date()));
    expect(Math.abs(Date.parse(r.serverTime) - Date.now())).toBeLessThan(60_000);
  });

  it('lets staff preview a season before it starts, and nobody else', async () => {
    expect((await runtime(admin.authHeader, '?previewSeason=xmas')).season).toBe('xmas');
    expect((await runtime(admin.authHeader, '?previewSeason=newyear')).season).toBe('newyear');
    expect((await runtime(user.authHeader, '?previewSeason=xmas')).season).toBe(seasonAt(new Date()));
    expect((await runtime({}, '?previewSeason=xmas')).season).toBe(seasonAt(new Date()));
  });
});
