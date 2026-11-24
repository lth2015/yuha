import { ApiError, apiFetch, setToken } from './api';

/**
 * A song without an account (docs/GROWTH_SPEC.md, part three), the browser's
 * half.
 *
 * Starting a trial puts the guest's session where an account's goes, so the
 * home composer, the job's progress and the song page need nothing new; and
 * keeps a second copy under its own key, because signing up replaces the
 * session and that copy is what claims the song afterwards.
 *
 * Both keys are named in the privacy text (docs/legal/PRIVACY_CHANGES_2026-11.md).
 */
const DEVICE_KEY = 'yuha.trial-device';
const GUEST_KEY = 'yuha.guest';

function deviceId(): string {
  try {
    const kept = localStorage.getItem(DEVICE_KEY);
    if (kept && /^[0-9a-f-]{36}$/i.test(kept)) return kept;
    const made = crypto.randomUUID();
    localStorage.setItem(DEVICE_KEY, made);
    return made;
  } catch {
    // No storage: a fresh id each time, which the server's network limit still bounds.
    return crypto.randomUUID();
  }
}

export async function startGuestTrial(): Promise<void> {
  const res = await apiFetch<{ token: string }>('/v1/trial/start', {
    method: 'POST',
    body: { deviceId: deviceId(), ageConfirmed: true, termsAccepted: true },
  });
  setToken(res.token);
  try {
    localStorage.setItem(GUEST_KEY, res.token);
  } catch {
    /* the song can still be made; it just cannot follow the person into an account */
  }
}

/** Whether this browser holds a trial that no account has taken yet. */
export function hasPendingTrial(): boolean {
  return pendingGuest() !== null;
}

/**
 * "Not now": the trial stays the guest's, and is deleted with its song seven
 * days after it was made (docs/legal/PRIVACY_CHANGES_2026-11.md). Only this
 * browser forgets it; nothing on the server is asked to change.
 */
export function declinePendingTrial(): void {
  forgetGuest();
}

function pendingGuest(): string | null {
  try {
    return localStorage.getItem(GUEST_KEY);
  } catch {
    return null;
  }
}

function forgetGuest(): void {
  try {
    localStorage.removeItem(GUEST_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * When the person says yes (components/TrialClaimAsk.tsx), never on its own:
 * a browser can be shared, and whoever signs in next is not necessarily
 * whoever made the song. Brings the trial's song into the account, once. Whatever the
 * answer, the kept token is spent: claimed, claimed already, ended or never
 * valid, there is nothing more it can do. Only a failure to reach the server
 * keeps it for the next sign-in.
 */
export async function claimPendingTrial(): Promise<boolean> {
  const guestToken = pendingGuest();
  if (!guestToken) return false;
  try {
    const res = await apiFetch<{ claimed: number }>('/v1/trial/claim', { method: 'POST', body: { guestToken } });
    forgetGuest();
    return res.claimed > 0;
  } catch (err) {
    if (err instanceof ApiError && err.status > 0) forgetGuest();
    return false;
  }
}
