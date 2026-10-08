/**
 * A path the client may ask us to send a browser back to, and nothing else.
 *
 * `POST /v1/checkout` accepts `successPath` and `cancelPath`, and they were
 * pasted straight onto `PUBLIC_WEB_URL`:
 *
 *   `${PUBLIC_WEB_URL}${successPath}` with successPath = "@evil.example/"
 *     → https://yuha.studio@evil.example/   host: evil.example
 *   with successPath = ".evil.example"
 *     → https://yuha.studio.evil.example/   host: yuha.studio.evil.example
 *
 * No trailing slash on `publicWebUrl` in any environment, so `@` reads as
 * userinfo and a leading `.` extends the hostname. The result is a genuine
 * `checkout.stripe.com` link, for the real account, that returns the payer to
 * somebody else's host — high-credibility phishing with our own payment page
 * as the lure. The schema said `z.string().max(200)` and nothing else.
 *
 * The web app has had `safeInternalPath` since the `next` parameter was added
 * (`apps/web/src/lib/paths.ts`, with its own tests). A client-side guard on a
 * value the client supplies is not a guard, so this is the server's copy, and
 * it is stricter: the browser one only has to keep the SPA's router happy,
 * this one has to survive string concatenation onto an origin.
 */
export function safeInternalPath(value: string | undefined | null): string | null {
  if (!value) return null;
  // Must be a path, and must not be protocol-relative — `//evil.example` and
  // `/\evil.example` are both read as a host by browsers.
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//') || value.startsWith('/\\')) return null;
  /*
   * No control characters, and no whitespace. A newline or a NUL in a URL is
   * a header-splitting or parser-confusion attempt rather than a path, and
   * `encodeURI` would hide it rather than refuse it.
   */
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return null;
  /*
   * No query and no fragment: both URLs this builds append their own
   * `?order_id=…`, so a caller-supplied `?` would produce two query strings
   * and a `#` would swallow ours. The caller wants a path.
   */
  if (value.includes('?') || value.includes('#')) return null;
  // Belt and braces: whatever the above let through must still parse as a
  // path on the intended origin and come back with that origin unchanged.
  return value;
}

/**
 * Joins a caller-supplied path onto our own origin, refusing anything that
 * would change the origin.
 *
 * Built with `new URL` rather than concatenation, and then checked: if the
 * result's origin is not the one we passed in, the path is refused whatever
 * it looked like.
 */
export function internalUrl(origin: string, path: string, fallback: string): string {
  const safe = safeInternalPath(path) ?? fallback;
  const url = new URL(safe, origin);
  if (url.origin !== new URL(origin).origin) return new URL(fallback, origin).toString();
  return url.toString();
}
