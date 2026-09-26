import { API_BASE } from './api';

/**
 * Tell the server a page crashed.
 *
 * The error boundary is an improvement and a regression at once: a render
 * throw used to produce a blank page and a user who complained — which is how
 * `/pricing` was eventually discovered to have been broken for eight days —
 * and now produces a calm panel nobody mentions. Something has to write it
 * down.
 *
 * Three rules, because a crash reporter that misbehaves is worse than none:
 *
 *   1. It never throws. Every path is caught, including the ones that look
 *      like they cannot fail.
 *   2. It never carries the session token, so a report cannot be tied back to
 *      a person. `apiFetch` would have attached one; this uses bare `fetch`,
 *      which also depends on less code that may be part of what just broke.
 *   3. It never sends the URL. The query string on this product carries
 *      drafts and edit targets — `?edit=`, and on the composer the prompt
 *      itself. Only a normalised path leaves the browser.
 */

/** `/song/2f9c…-…` → `/song/:id`, so one crash groups instead of fanning out. */
function normaliseRoute(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => {
      if (!seg) return seg;
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) return ':id';
      if (/^\d+$/.test(seg)) return ':n';
      // Opaque ids that are not UUIDs still look like ids: long and mixed.
      if (seg.length >= 16 && /\d/.test(seg) && /[a-z]/i.test(seg)) return ':id';
      return seg;
    })
    .join('/')
    .slice(0, 120);
}

/** The nearest component name React could give us, or null. */
function firstComponent(componentStack: string | null | undefined): string | null {
  if (!componentStack) return null;
  for (const line of componentStack.split('\n')) {
    const m = /^\s*(?:in|at)\s+([A-Za-z0-9_$.]+)/.exec(line);
    if (m?.[1]) return m[1].slice(0, 80);
  }
  return null;
}

/**
 * At most this many reports per page load, and never the same one twice.
 * A crash loop can re-render faster than any human, and the point is to learn
 * that a page is broken, not to measure how fast it breaks.
 */
const MAX_PER_PAGE = 3;
const seen = new Set<string>();

export function reportCrash(error: Error, componentStack?: string | null): void {
  try {
    const message = String(error?.message ?? error ?? 'unknown').slice(0, 300);
    const route = normaliseRoute(window.location.pathname);
    const key = `${route}::${message}`;
    if (seen.has(key) || seen.size >= MAX_PER_PAGE) return;
    seen.add(key);

    let lang: string | null = null;
    try {
      lang = localStorage.getItem('yuha.lang');
    } catch {
      /* private browsing */
    }

    void fetch(`${API_BASE}/v1/client-errors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // Survives the navigation a user often makes straight after a crash.
      keepalive: true,
      body: JSON.stringify({
        message,
        route,
        component: firstComponent(componentStack),
        lang,
      }),
    }).catch(() => undefined);
  } catch {
    /* Reporting a crash must never become a second one. */
  }
}
