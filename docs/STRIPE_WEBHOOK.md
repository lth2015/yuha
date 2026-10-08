# The Stripe webhook endpoint

What to put in the Stripe dashboard, and what the code on the other end does
with it. One list, because the alternative is three that disagree.

## The endpoint

```
POST https://yuha.studio/api/webhooks/stripe
```

`POST /v1/webhooks/stripe` serves the same handler and is kept: the Stripe CLI
forwarder in `deploy/dgx/app/docker-compose.yml` and any endpoint registered
before this change post to it. Both paths write to one `webhook_events` table
keyed on Stripe's own event id, so an event arriving on both is stored once and
processed once. Neither redirects to the other — a 3xx is not something a Stripe
endpoint may answer, and following one would re-send the body under a signature
computed for the first request.

The paths come from `apps/api/src/webhook-paths.ts` and nowhere else.
`tests/stripe-webhook-path.test.ts` asserts that the reverse proxy and the ALB
ingress both route every path in that list, and that every path keeps its raw
body — the two ways this breaks silently.

### Why the routing is the risky part

In front of the API sits nginx with `location / { try_files $uri /index.html; }`.
A POST to a path nginx does not proxy is answered **200, with the single-page
app's HTML**. Stripe reads 200 as delivered and never retries. So the failure
mode of a missing route is not a 404 in a log: it is a customer charged, an
event acknowledged, credits never granted, and nothing in either dashboard
suggesting a problem. `deploy/dgx/update.sh` now POSTs an unsigned body to
`/api/webhooks/stripe` after every deploy and fails unless the answer is
`400 WEBHOOK_SIGNATURE_INVALID` — a 200 with HTML cannot pass that, and the SPA
cannot produce a 400.

`/api`, `/v1`, `/health` and `/ready` are listed explicitly in the chart's
Ingress ahead of the `/` catch-all. On the day they were written they changed
nothing, because `/` already routed everything to the API. They exist for the
day something else is put behind this host — the S3 + CloudFront distribution
for the web bundle is already written in `infra/terraform/compute.tf`, and
`deploy/envs/production.yaml` points `publicWebUrl` at this same name.

## Format and API version

| Setting | Value |
| --- | --- |
| Payload style | **Snapshot** events |
| API version | **2025-03-31.basil** |

Snapshot is not a preference here, it is the only format this code can read.
`StripePaymentsAdapter.verifyWebhook` calls `webhooks.constructEvent`, which
returns the snapshot envelope, and every handler reads fields straight off
`event.data.object` — an amount, a `payment_status`, a subscription's items. A
thin event carries a `related_object` reference instead and has to be fetched
before it says anything; the installed SDK (`stripe@17.7.0`) does have
`parseThinEvent`, and this code does not call it. The fourteen event types below
are v1 event types in any case.

Switching this endpoint to Thin would therefore not degrade gracefully: the
signature would still verify, the row would still be stored, and each handler
would read `undefined` off an object that is not there.

`2025-03-31.basil` is compatible and is kept. It was pinned because an account
with Managed Payments refuses a Checkout Session on the SDK's own
`2025-02-24.acacia`, and it is now also required explicitly: `STRIPE_API_VERSION`
must be set in production or the API refuses to start. The reason is that the
payload shape moves between versions and this code reads both sides of two such
moves — an Invoice's subscription under `parent.subscription_details`, and a
Subscription's current period on its items rather than on itself (see the
comments in `apps/api/src/services/webhooks.ts`). Left unset, the version would
be whatever the SDK happens to pin, so a routine dependency bump would change
the shape of live events with no code change to review.

## The events to tick

Fourteen, which is exactly the set `processWebhookEvent` routes. Anything else
Stripe sends is stored and marked `ignored`, so subscribing to more is harmless
and subscribing to fewer is a branch that cannot be reached.

| Event | Why it is needed |
| --- | --- |
| `checkout.session.completed` | A one-time purchase finished. Completion is **not** treated as payment: the session is re-read from Stripe and `payment_status` must be `paid` |
| `checkout.session.async_payment_succeeded` | Konbini and other delayed methods pay here, hours later, not at completion |
| `checkout.session.async_payment_failed` | The delayed payment did not arrive |
| `checkout.session.expired` | The customer never paid; the order becomes `canceled` |
| `invoice.paid` | A subscription period — first one and every renewal. **This**, keyed on the invoice and the period, is what grants subscription credits; a subscription checkout grants nothing |
| `invoice.payment_succeeded` | The same moment under its other name on some accounts; deduped by event id and by the invoice key, so both arriving grants one period |
| `invoice.payment_failed` | A renewal failed — the subscription goes `past_due` and the customer is told |
| `customer.subscription.created` | The period is recorded as soon as it exists, so a first invoice that cannot be resolved live still has dates |
| `customer.subscription.updated` | Plan change, cancel-at-period-end, status change |
| `customer.subscription.deleted` | Ended |
| `charge.refunded` | A refund against the charge; credits are revoked if unused |
| `refund.created` | How a refund issued from the dashboard arrives when no charge object is updated |
| `charge.dispute.created` | A chargeback was opened — operations is signalled |
| `charge.dispute.closed` | The moment it is **lost** and the money is actually gone. This is the one that revokes |

Copy-pasteable:

```
checkout.session.completed
checkout.session.async_payment_succeeded
checkout.session.async_payment_failed
checkout.session.expired
invoice.paid
invoice.payment_succeeded
invoice.payment_failed
customer.subscription.created
customer.subscription.updated
customer.subscription.deleted
charge.refunded
refund.created
charge.dispute.created
charge.dispute.closed
```

## Delivery, idempotency and what answers what

```
signature verified ──no──▶ stored as unverified, never claimed ──▶ 400
       │yes
       ▼
recordWebhookEvent ──throws──▶ 5xx, Stripe retries for three days
       │ok
       ▼
      200  { received: true, duplicate: … }      the worker processes it later
```

The 200 means *saved*, never *handled*: it is sent only after the row exists.
That is deliberate — a slow handler would otherwise cause provider-side
retries, and an acknowledgement sent before the insert would turn a transient
database error into a permanently lost payment with no second chance.

Three independent layers make repeats, retries and out-of-order delivery safe:

1. **`webhook_events.event_id`** is unique per provider, so the same event
   delivered twice — including once per path — is stored once.
2. **Business keys.** `entitlement_batches (user, source, source_ref)` with the
   order id, `track_licenses` unique on (track, buyer) and on (order), and the
   `orders.status` transition in `markOrderPaid`. So two *different* events
   describing one payment still grant once. This is the layer that matters:
   `checkout.session.completed` and `invoice.paid` can both describe the same
   subscription, and a card payment and an on-chain payment can both settle the
   same order.
3. **Re-reading the provider.** Where an event could be stale, the live object
   decides — the checkout session's `payment_status`, the subscription's current
   period — so events arriving out of order converge on the newer state rather
   than on the last one to arrive.

Unverified deliveries are recorded under an event id bucketed to the minute,
not per request: the route is public and unauthenticated, so a one-row-per-POST
audit trail is something anyone could grow without limit.

## Secrets, and where they are not

`STRIPE_WEBHOOK_SECRET` is the endpoint's own signing secret (`whsec_…`), read
from the environment at start-up. It lives in **AWS Secrets Manager**, in the
secret named by `deploy/cluster/external-secrets.yaml`, which External Secrets
projects into the `yuha-runtime` Kubernetes Secret that the chart mounts with
`envFrom`. On the DGX stack it is a line in `~/yuha-app/app.env`, which is not
in this repository.

It is not in source, not in the image, not in the ConfigMap, not in the web
bundle, and in none of the API's own log lines — `stripe-signature` is in the
Fastify logger's redact list, and the start-up check on this variable tests its
prefix and never interpolates the value. One exception worth knowing rather than
hiding: on the DGX stack `deploy/dgx/app/deploy_yuha.sh` reads the CLI's test
mode secret back out of the `stripe` container's own logs (`grep -o
'whsec_[A-Za-z0-9]*'`) and passes it over ssh, so on that box it is in container
logs and briefly in a process argument. That is a test-mode secret on an
intranet machine, and the live one never goes near it. A different endpoint
(test mode, the CLI, a second environment) has a different secret; there is one
per endpoint.

Price ids and `STRIPE_API_VERSION` are not secrets and live in the ConfigMap via
`deploy/envs/*.yaml`. `STRIPE_SECRET_KEY` is a secret and sits beside the
webhook secret. Production additionally refuses to start on anything that is not
`sk_live_…`: `config.ts` rejects an `sk_test_` key by name, and
`StripePaymentsAdapter`'s constructor — built in `createContext`, before the
server — throws for any key that does not begin `sk_live_` when
`expectLiveMode` is set, which covers a restricted `rk_…` key too.

## Verifying without charging anybody

In order, cheapest first. None of these moves real money.

```bash
# 1. The path reaches the backend at all. Unsigned, so 400 is the pass.
curl -i -X POST https://yuha.studio/api/webhooks/stripe \
  -H 'content-type: application/json' --data '{}'
# → HTTP/1.1 400 … {"code":"WEBHOOK_SIGNATURE_INVALID","message":"signature verification failed"}
# Read the message, not only the code: the same 400 saying "raw body was not
# preserved" means the route is served but its bytes are gone, and every real
# event is being refused too. A 200 with HTML means the request never left the
# SPA. A 3xx is also a failure.

# 2. Signature verification and the grant path, against a sandbox.
stripe listen --forward-to localhost:4000/api/webhooks/stripe
stripe trigger checkout.session.completed
stripe trigger invoice.paid

# 3. Replay. The dashboard's "Resend" on a delivered event, or
stripe events resend evt_…
# → the second delivery answers {"received":true,"duplicate":true} and the
#   balance does not move.
```

`pnpm test tests/stripe-webhook-path.test.ts` covers the same ground offline:
both paths accept a signed event and answer JSON rather than a redirect, dedupe
against each other, refuse a forged or unsigned delivery with 400, and answer
5xx when the event cannot be stored. `tests/payments.test.ts` drives every
purchase through `/api/webhooks/stripe` with the simulated adapter, which signs
and verifies exactly as Stripe does; its three signature-rejection cases post to
`/v1/webhooks/stripe` directly, because that path is what they are about.

Real-money acceptance — one small live purchase and its refund — is Phase E in
`docs/OPEN_ITEMS.md` and is a person's job, not a session's.
