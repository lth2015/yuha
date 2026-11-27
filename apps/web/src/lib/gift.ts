import { apiFetch } from './api';

/**
 * Counting what an invitation leads to (docs/GIFT_INVITATION_PLAN.md):
 * views, plays, the call to make a song, and — on the create page — whether
 * that visit became a song. A random visitor id kept in this browser makes
 * a refresh count once a day; the server hashes it and never stores words.
 */
const VISITOR_KEY = 'yuha.giftVisitor';
/** Set when "I want to send a song too" is pressed; session only, so the link's token never leaves the tab. */
export const GIFT_ORIGIN_KEY = 'yuha.giftOrigin';

function visitorId(): string {
  try {
    const known = localStorage.getItem(VISITOR_KEY);
    if (known) return known;
    const id = crypto.randomUUID();
    localStorage.setItem(VISITOR_KEY, id);
    return id;
  } catch {
    return crypto.randomUUID();
  }
}

export function giftEvent(token: string, name: string): void {
  void apiFetch(`/v1/gift/${token}/events`, { method: 'POST', body: { name, visitor: visitorId() } }).catch(() => undefined);
}

/** The invitation this tab came from, if the create page was reached from one. */
export function giftOrigin(): string | null {
  try {
    return sessionStorage.getItem(GIFT_ORIGIN_KEY);
  } catch {
    return null;
  }
}

export function forgetGiftOrigin(): void {
  try {
    sessionStorage.removeItem(GIFT_ORIGIN_KEY);
  } catch {
    /* nothing to forget */
  }
}
