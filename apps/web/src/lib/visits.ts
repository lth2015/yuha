import { apiFetch } from './api';

/**
 * Reports a page view to our own API, for the operator dashboard's visit
 * numbers. Anonymous by construction:
 *
 *   - the visitor id is a random UUID made here and kept in localStorage —
 *     not the account id, not an IP, not a fingerprint. Clearing site data
 *     resets it, and that is fine;
 *   - only the path is sent, never the query string or hash, which can carry
 *     tokens (the Google callback does);
 *   - the referring site is sent as its host only, and only when it is
 *     another site;
 *   - it goes to this service's API and nowhere else.
 *
 * Failures are swallowed: counting must never interrupt the page.
 */
const KEY = 'yuha.visitor';
let memoryId: string | null = null;
let referrerSent = false;

function visitorId(): string {
  try {
    const existing = localStorage.getItem(KEY);
    if (existing && /^[0-9a-f-]{36}$/i.test(existing)) return existing;
    const id = crypto.randomUUID();
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    // Private browsing or storage disabled: one id for this page load.
    return (memoryId ??= crypto.randomUUID());
  }
}

function externalReferrerHost(): string | undefined {
  if (referrerSent) return undefined;
  referrerSent = true;
  try {
    if (!document.referrer) return undefined;
    const host = new URL(document.referrer).hostname;
    return host && host !== window.location.hostname ? host : undefined;
  } catch {
    return undefined;
  }
}

export function reportVisit(path: string): void {
  const refHost = externalReferrerHost();
  void apiFetch('/v1/visits', {
    method: 'POST',
    body: { visitorId: visitorId(), path, ...(refHost ? { refHost } : {}) },
  }).catch(() => undefined);
}
