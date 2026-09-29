/**
 * A return path that may only lead somewhere inside this app.
 *
 * `next=` and `from=` arrive in query strings anyone can write, so they are
 * accepted only as absolute in-app paths. `//host` is protocol-relative and
 * leaves the site, and browsers read `/\host` the same way, so both are refused.
 */
export function safeInternalPath(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  return value;
}

/**
 * Where to land after Google sign-in, carried across the OAuth round trip.
 *
 * The Google button pointed at `/v1/auth/google/start` with no `next`, the API
 * ignores the query anyway, and the callback always went to /create — so
 * someone who pressed "buy" while signed out came back from Google to the
 * studio instead of the plan they had chosen. The development login honoured
 * `next`; the one path production users actually take did not.
 *
 * sessionStorage, not the OAuth `state`: it survives a same-tab round trip to
 * Google and back, and it needs no change to what the API signs.
 */
export const AUTH_NEXT_KEY = 'yuha.authNext';
