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
let landingSeen = false;
/** The source found on this page load, for when storage will not keep it. */
let thisLoad: string | null = null;

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

/** The site that sent this page load, if it is another site. Reads only; nothing is consumed. */
function landingReferrerHost(): string | undefined {
  try {
    if (!document.referrer) return undefined;
    const host = new URL(document.referrer).hostname;
    return host && host !== window.location.hostname ? host : undefined;
  } catch {
    return undefined;
  }
}

/** The referring site, once per page load: later in-app navigations were not referred by it. */
function externalReferrerHost(): string | undefined {
  if (referrerSent) return undefined;
  referrerSent = true;
  return landingReferrerHost();
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

/**
 * Search engines' results pages, not every site their companies run: a link
 * in a Google Doc, Gmail or a Naver blog is someone sharing, and counting it
 * as a search credited organic search with signups it never brought.
 */
const SEARCH = [
  /^(www\.)?google\.[a-z.]+$/,
  /^(www\.|cn\.)?bing\.com$/,
  /^([a-z]+\.)?search\.yahoo\.[a-z.]+$/,
  /^(www\.|html\.)?duckduckgo\.com$/,
  /^(www\.)?yandex\.[a-z.]+$/,
  /^(www\.|m\.)?baidu\.com$/,
  /^(m\.)?search\.naver\.com$/,
  /^(www\.)?ecosia\.org$/,
  /^search\.brave\.com$/,
];

/**
 * A visit from a search engine with no tag of its own is named after the page
 * it landed on, `seo-<page>-<lang>` (docs/ITERATION_EN_JA_MV.md): which
 * prerendered page, in which language, a search brought somebody to.
 */
export function organicSource(path: string, search: string, refHost: string | undefined, docLang: string): string | null {
  if (!refHost || !SEARCH.some((r) => r.test(refHost))) return null;
  // `/ja` as well as `/ja/`: a language root with no slash is that language's home.
  const m = /^\/(?:(zh|ja|en)(?:\/|$))?([a-z-]*?)(?:\.html)?\/?$/.exec(path);
  if (!m) return null;
  const page = !m[2] || m[2] === 'index' ? 'home' : m[2];
  const lang = m[1] ?? new URLSearchParams(search).get('lang') ?? (docLang.startsWith('zh') ? 'zh' : docLang.slice(0, 2));
  return normalizeSource(`seo-${page}-${['zh', 'ja', 'en'].includes(lang) ? lang : 'en'}`);
}

function captureSource(): string | null {
  const kept = keptSource();
  // Only the page a search landed on is named after it. document.referrer
  // stays the same through in-app navigation, so a later page must not take
  // the credit for a search that landed somewhere else.
  const atLanding = !landingSeen;
  landingSeen = true;
  if (kept) return kept.source;
  if (thisLoad) return thisLoad;
  try {
    const q = new URLSearchParams(window.location.search);
    const source =
      normalizeSource(q.get('src') ?? q.get('utm_campaign') ?? q.get('utm_source')) ??
      (atLanding
        ? organicSource(window.location.pathname, window.location.search, landingReferrerHost(), document.documentElement.lang || 'zh')
        : null);
    if (!source) return null;
    // Held for this page load first: with storage blocked, the setItem below
    // throws, and the landing (read only once) would otherwise be lost.
    thisLoad = source;
    localStorage.setItem(SOURCE_KEY, JSON.stringify({ source, at: Date.now() }));
    return source;
  } catch {
    return thisLoad;
  }
}

/** The campaign this browser came through, for a trial to carry (it has no account to report to). */
export function currentSource(): string | null {
  return captureSource();
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
