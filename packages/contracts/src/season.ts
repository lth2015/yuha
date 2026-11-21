/**
 * Christmas and New Year (docs/HOLIDAY_SPEC.md), in Japan time.
 *
 * The server decides, from its own clock: a person's laptop set to the wrong
 * day must not see Christmas in March. The web app reads the answer from
 * GET /v1/runtime and works out the small moments (snow on the 24th, the
 * countdown) from the server's time, not its own.
 */
export const SEASONS = ['xmas', 'newyear'] as const;
export type Season = (typeof SEASONS)[number];

const JST_MS = 9 * 3600_000;

/** Month (1-12), day and hour in Japan for an instant. */
function jst(at: Date): { month: number; day: number; hour: number; minute: number } {
  const d = new Date(at.getTime() + JST_MS);
  return { month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() };
}

/** 12/10-12/25 is Christmas; 12/26-1/7 is New Year; otherwise none. */
export function seasonAt(at: Date): Season | null {
  const { month, day } = jst(at);
  if (month === 12 && day >= 10 && day <= 25) return 'xmas';
  if ((month === 12 && day >= 26) || (month === 1 && day <= 7)) return 'newyear';
  return null;
}

/**
 * The small things the site does on particular days (the spec's easter-egg
 * table). Each is a moment, not a season: snow only on the 24th and 25th,
 * the countdown only in the last hour of the year and the first ten minutes
 * of the next.
 */
export type HolidayMoment = 'snow' | 'countdown' | 'new-year-greeting';

export function holidayMomentsAt(at: Date): HolidayMoment[] {
  const { month, day, hour, minute } = jst(at);
  const out: HolidayMoment[] = [];
  if (month === 12 && (day === 24 || day === 25)) out.push('snow');
  if ((month === 12 && day === 31 && hour === 23) || (month === 1 && day === 1 && hour === 0 && minute < 10)) out.push('countdown');
  if (month === 1 && day >= 1 && day <= 3) out.push('new-year-greeting');
  return out;
}

/** The season an occasion belongs to, for pages that dress a song by what it is for, not by the date. */
export function seasonOfOccasion(occasion: string | null | undefined): Season | null {
  return occasion === 'christmas' ? 'xmas' : occasion === 'new_year' ? 'newyear' : null;
}
