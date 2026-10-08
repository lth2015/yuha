/**
 * Where the Stripe webhook listens.
 *
 * Two paths, one handler, one list.
 *
 * `/v1/webhooks/stripe` is the original and cannot be dropped: the Stripe CLI
 * forwarder in `deploy/dgx/app/docker-compose.yml` posts to it, and any
 * endpoint already registered in the Stripe dashboard points at it. Silently
 * moving the path would stop every one of those without an error anybody sees
 * — the request would 404, Stripe would retry for three days, and the first
 * symptom would be a customer who paid and received nothing.
 *
 * `/api/webhooks/stripe` is the path operations asked for, and the one the
 * live endpoint is configured with. It is not an alias in the redirect sense:
 * a 3xx would make Stripe follow with the signature intact but the body
 * re-sent, and the docs are explicit that an endpoint must answer directly.
 * Both paths run the same handler, so there is no second verification or
 * dedupe implementation to drift.
 *
 * The list is exported because `server.ts` has to agree with it. The raw body
 * is what the signature is computed over, so a path registered as a route but
 * missed by the content-type parser arrives as parsed JSON and every delivery
 * to it is rejected as unsigned — which looks exactly like a wrong secret and
 * is the single most likely way this gets broken later.
 * `tests/stripe-webhook-path.test.ts` asserts the two agree.
 */
export const STRIPE_WEBHOOK_PATHS = ['/api/webhooks/stripe', '/v1/webhooks/stripe'] as const;

/**
 * The one to configure, and the one anything in-repo that has to pick a single
 * URL should pick: the demo's own injected delivery, the CLI forwarder, the
 * post-deploy check.
 *
 * Named rather than left as `STRIPE_WEBHOOK_PATHS[0]`, because an index is not
 * a decision. Reordering the array above is a harmless-looking edit that would
 * otherwise move the demo pipeline onto the other path and fail a test with a
 * message about something else.
 */
export const STRIPE_WEBHOOK_PRIMARY_PATH: (typeof STRIPE_WEBHOOK_PATHS)[number] = '/api/webhooks/stripe';

/**
 * Prefixes whose request body must survive as the exact bytes that were sent.
 *
 * Deliberately prefixes and not the exact list above: a future provider
 * webhook added under either namespace needs the same treatment, and the
 * failure mode of forgetting is a signature that cannot be verified rather
 * than anything loud.
 */
const RAW_BODY_PREFIXES = ['/api/webhooks/', '/v1/webhooks/'] as const;

export function keepsRawBody(url: string): boolean {
  return RAW_BODY_PREFIXES.some((prefix) => url.startsWith(prefix));
}
