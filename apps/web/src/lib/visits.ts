import { normalizeSource } from '@yuha/contracts';
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

/**
 * The campaign this browser arrived through (docs/ATTRIBUTION_SPEC.md).
 *
 * A link may carry `?src=x-xmas-1` (or utm_campaign / utm_source). The first
 * one seen is kept for thirty days and sent with every page view, so a person
 * who clicks an ad today and comes back by bookmark tomorrow is still that
 * ad's visitor. First touch, not last: a second campaign link inside the
 * thirty days does not take the credit from the one that brought them.
 */
const SOURCE_KEY = 'yuha.source';
const SOURCE_DAYS = 30;

function keptSource(): { source: string; at: number; sent?: boolean } | null {
  try {
    const raw = localStorage.getItem(SOURCE_KEY);
    if (!raw) return null;
    const kept = JSON.parse(raw) as { source?: unknown; at?: unknown; sent?: unknown };
    const source = normalizeSource(kept.source);
    if (!source || typeof kept.at !== 'number' || Date.now() - kept.at > SOURCE_DAYS * 86_400_000) return null;
    return { source, at: kept.at, sent: kept.sent === true };
  } catch {
    return null;
  }
}

function captureSource(): string | null {
  const kept = keptSource();
  if (kept) return kept.source;
  try {
    const q = new URLSearchParams(window.location.search);
    const source = normalizeSource(q.get('src') ?? q.get('utm_campaign') ?? q.get('utm_source'));
    if (!source) return null;
    localStorage.setItem(SOURCE_KEY, JSON.stringify({ source, at: Date.now() }));
    return source;
  } catch {
    return null;
  }
}

/**
 * After sign-in: tell the server once which campaign this browser came
 * through. The server keeps it only for an account made in the last day,
 * so sending it for an older account changes nothing.
 */
export function reportSourceOnce(): void {
  // The sign-in check can finish before the first page view is reported, so
  // the landing URL is read here too rather than left to reportVisit.
  captureSource();
  const kept = keptSource();
  if (!kept || kept.sent) return;
  void apiFetch('/v1/me/source', { method: 'POST', body: { source: kept.source } })
    .then(() => {
      try {
        localStorage.setItem(SOURCE_KEY, JSON.stringify({ ...kept, sent: true }));
      } catch {
        /* ignore */
      }
    })
    .catch(() => undefined);
}

export function reportVisit(path: string): void {
  const refHost = externalReferrerHost();
  const source = captureSource();
  void apiFetch('/v1/visits', {
    method: 'POST',
    body: { visitorId: visitorId(), path, ...(refHost ? { refHost } : {}), ...(source ? { source } : {}) },
  }).catch(() => undefined);
}
