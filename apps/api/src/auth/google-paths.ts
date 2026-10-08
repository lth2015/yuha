/**
 * Where Google sends the browser back to, as one string.
 *
 * Google compares the `redirect_uri` on the authorization request against the
 * list registered in the Cloud Console **byte for byte** — scheme, host, port,
 * path, trailing slash — and a difference is `redirect_uri_mismatch`, an error
 * on Google's own page before the request ever reaches us. So there is no
 * sign-in to debug and nothing in our logs; the only evidence is the URL in
 * the address bar.
 *
 * Two mistakes are easy and both look reasonable:
 *
 *  - registering the SPA's path, `/auth/google/callback`. That route exists
 *    and is part of the flow — it is where THIS server sends the browser
 *    afterwards, carrying a one-time code — so it looks like the callback.
 *    Google must be given the API's path, and the SPA's must not be
 *    registered: a browser arriving there with Google's `code` finds a page
 *    that expects ours.
 *  - keeping the old host after a move. The variable is a full absolute URL
 *    rather than a path, because Google needs the origin, which means every
 *    environment has a different value and a copied one points at the
 *    previous deployment.
 *
 * Kept in a module with no imports of its own so that `config.ts`,
 * `routes/auth.ts` and the tests can all name the same constant without a
 * cycle, and `validate` can refuse a `GOOGLE_REDIRECT_URI` whose path is not
 * this one.
 */
export const GOOGLE_CALLBACK_PATH = '/v1/auth/google/callback';

/** Where the API sends the browser once it holds a one-time code. Never given to Google. */
export const GOOGLE_WEB_RETURN_PATH = '/auth/google/callback';

/**
 * What to register in the Cloud Console, and what `GOOGLE_REDIRECT_URI` must
 * be, for an API served at `apiOrigin`.
 */
export function googleRedirectUri(apiOrigin: string): string {
  return new URL(GOOGLE_CALLBACK_PATH, apiOrigin).toString();
}
