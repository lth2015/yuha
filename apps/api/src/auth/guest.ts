import type { AppConfig } from '../config.js';
import { SessionTokenIssuer } from './tokens.js';

/**
 * Sessions for trials without an account (docs/GROWTH_SPEC.md, part three).
 *
 * The same signed token as every other session, in its own identity space:
 * `provider: 'guest'`, which no sign-in adapter accepts, so a guest token can
 * never be spent as an account's and an account's never resolves to a guest.
 * Seven days: the trial itself is deleted after seven.
 */
export const GUEST_PROVIDER = 'guest';
const SEVEN_DAYS = 7 * 24 * 3600;

export function guestSessionIssuer(cfg: AppConfig): SessionTokenIssuer | null {
  const secret = cfg.GOOGLE_SESSION_SECRET ?? cfg.DEV_AUTH_SECRET;
  return secret ? new SessionTokenIssuer(`${secret}:guest`, SEVEN_DAYS) : null;
}
