/**
 * Credentials that travel in a query string.
 *
 * SEC-06 keeps prompts, tokens, cookies and card-ish fields out of the log, and
 * the redaction list covers the headers and the body. It did not cover the URL,
 * and the local storage adapter serves every download through
 * `/v1/files?zone=…&key=…&expires=…&sig=…` — so the request log held a working
 * download link for each one, usable until the signature expired.
 *
 * Only the local adapter is affected: against S3 the browser fetches a signed
 * S3 url directly and it never reaches this process. A development exposure,
 * which is a reason to fix it cheaply rather than a reason to leave it.
 *
 * The path and the ordinary parameters stay. A request log that cannot say what
 * was asked for has been redacted into uselessness.
 */
const SECRET_PARAMS = new Set([
  'sig',
  'signature',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  // The OAuth authorization code is the one that buys a session.
  'code',
  'state',
  'secret',
  'key_secret',
  'password',
]);

export function redactUrlSecrets(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const path = url.slice(0, q);
  const query = url.slice(q + 1);
  if (!query) return url;

  let touched = false;
  const parts = query.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    const name = (eq < 0 ? pair : pair.slice(0, eq)).toLowerCase();
    if (!SECRET_PARAMS.has(name)) return pair;
    touched = true;
    return `${eq < 0 ? pair : pair.slice(0, eq)}=[redacted]`;
  });
  return touched ? `${path}?${parts.join('&')}` : url;
}
