# Stablecoin payments v1 — repository mapping and deviations

Phase A of the v1 specification (2026-10-05): what the repository actually
contains, where the specification and the code disagree, and the design points
that have to change before any of it is built.

Nothing here claims a regulatory, tax or licensing conclusion. The business
conclusions the specification lists in §3 remain outstanding and are not
affected by anything in this document.

## 1. The binding key cannot be the payer's nonce

The specification's §7 is the load-bearing part — without a receiving contract,
something has to tie an incoming transfer to one order, and it proposes
reserving the payer's account nonce: `prepare-payment` assigns and stores a
`payer_nonce`, and verification requires `tx.nonce` to equal it.

**We cannot reserve a nonce in someone else's wallet.** The next nonce is
*predicted* by reading the account's transaction count; it is not ours. While a
ten-minute quote sits open the owner can approve anything in any other dapp, or
MetaMask can retry a stuck transaction, and that consumes the number we wrote
down. The specification handles the replacement case ("a replacement sent
elsewhere closes the intent") but not the ordinary one: the payment then
arrives, correct in every other respect, with a nonce one higher than the
record, and an honest customer's money is sitting in our wallet attached to
nothing.

A field that cannot be relied on, checked as though it can, is the failure mode
this repository has `docs/` sections about. So:

- The nonce is **corroborating evidence**, recorded and reported, never the
  condition for fulfilment. A matching nonce raises confidence; a mismatch
  alone does not refuse a payment that is otherwise exact.
- The binding conditions that *are* enforceable, and all of which must hold:
  verified payer (SIWE, control proven), whitelisted token contract on
  chain 137, our receiver address, the exact atomic amount, inclusion at or
  after the quote's start block, and **exactly one open intent per payer per
  chain** — which §5 and §7 already require, and which is the condition that
  actually makes the match unambiguous.
- `(chain_id, tx_hash, log_index)` globally unique carries the anti-replay
  weight, as §7 says. That is what stops a copied hash or a reused old payment,
  and it does not depend on the nonce at all.
- Two open intents for one payer is therefore not a UX nicety but the
  correctness precondition. It must be enforced by a unique index, not by a
  check in application code.

Everything else in §7 stands.

## 2. Repository facts the specification assumes differently

| Specification says | Repository is | Consequence |
| --- | --- | --- |
| "read AGENTS.md" (§16 A) | No `AGENTS.md`. `CLAUDE.md` is the agent file | Behaviour code is written under the `tdd` skill, `code-review` runs before every commit, and `git merge --abort` / `rebase --abort` are forbidden |
| `POST /api/payments/...` (§11) | Every route is `/v1/...` (`apps/api/src/routes/*.ts`) | All eight endpoints renamed to `/v1/...`; `docs/API.md` updated |
| "if the architecture only supports one adapter, add explicit `payment_method` routing" (§9) | Confirmed: `PAYMENTS_ADAPTER` is a single global enum `'simulated' \| 'stripe'` (`config.ts:172`), one `ctx.payments` (`context.ts:38`), and `realPaymentsEnabled` in the runtime descriptor derives from the same value (`config.ts:582`) | `orders.payment_method` plus a router. The production refusal at `config.ts:378` ("production cannot use simulated payments") must be *widened*, not replaced — a stablecoin build with cards disabled is not a thing we want to be able to deploy by accident |
| a `stablecoin_direct` *adapter* | `PaymentsAdapter` (`packages/providers/src/payments/types.ts`) is Stripe-shaped: `createCheckout` returns a hosted URL, `verifyWebhook` over raw bytes, `retrieveCheckoutSession`, `retrieveSubscription`, `cancelSubscriptionAtPeriodEnd` | Stablecoin cannot implement that interface without stub methods that lie. It is a **sibling path**, not an implementation: its own routes and service, converging at the domain layer (`markOrderPaid` → `grantUnits` → `enqueueOutbox`). `ctx.payments` stays the card adapter |
| new `payment_outbox` table (§10) | `outbox` already exists with the exact property §9 asks for — enqueued in the same transaction as the state change — and `claimOutboxBatch` uses `FOR UPDATE SKIP LOCKED` | Reuse. No second outbox |
| new `entitlement_grant(order_id, kind, item_key)` unique (§9) | `entitlement_batches` is already unique on `(user_id, source, source_ref)` with `source_ref = 'order_paid:<order id>'`, taken under `lockUserEntitlements` (`packages/db/src/ledger.ts:101`). `track_licenses` is unique on both `(track_id, buyer_id)` and `(order_id)` | Exactly-once already holds for both DROP credits and Licence. Reuse; do not add a parallel uniqueness story |
| `orders`: `pending_payment → paid → fulfilled` (§9) | `orders.status` CHECK is `pending/paid/failed/refunded/partially_refunded/canceled`; fulfilment is **not a status** — it is `entitlement_granted_at` (`0001_init.sql:337`) | Map onto the existing vocabulary rather than introducing a second one. `review` has no home and needs its own column on the stablecoin tables, not a new order status |
| DROP 980 / CREATOR 1,980 / STUDIO 3,980 / Licence 980 JPY | Matches `apps/api/src/seed.ts` exactly, `currency: 'jpy'`, tax-inclusive | No conflict. **But** `tests/helpers/harness.ts` seeds the catalogue in USD at 499/999/2999 — a stablecoin test that inherits that seed would verify quote arithmetic against $4.99. Stablecoin tests seed JPY explicitly |
| `payment_received_at`, `service_delivered_at`, `revenue_recognized_at` (§13) | Two exist under other names: `orders.paid_at`, `orders.entitlement_granted_at`. `revenue_recognized_at` exists nowhere, and `packages/db/src/reporting.ts` has no recognition concept | One new column, and the policy that fills it is the 税理士's to set — the code must not default it to "wallet received" for every SKU, which is exactly what §13 warns against |
| — | No EVM library anywhere in the tree: no `viem`, `ethers`, `wagmi` or `web3` in any `package.json` | First dependency of its kind. `apps/web` is React 18 + Vite |
| — | `packages/providers/src/net/fetch-audio.ts` is the existing precedent for an allowlisted outbound HTTP client | The RPC client follows its shape rather than inventing one |

## 3. Build order

**B — core, no network.** Migrations (quotes, intents, attempts, transfer
events, wallet challenges, cursors, accounting events, refunds);
`orders.payment_method`; SIWE wallet identity with single-use server nonces;
quote with versioned config snapshot; the one-open-intent unique index; and the
verifier as a **pure function** over decoded transaction + receipt + logs, so
every rejection in §15 is a unit test with no RPC at all. Fake token, fake
chain. Written under `tdd`.

**C — chain integration.** Primary/secondary RPC with disagreement held, log
scanner with cursor and overlap re-scan, `finalized` finality, outbox
consumption, the web payment flow and order recovery, admin review, CSV export.

**D — test environment.** Local EVM with a mock token for decimals and rounding;
public testnet only with officially supported test tokens, isolated from
mainnet addresses and wallets.

**E — mainnet.** Not a code phase. §3's business conclusions, terms, key
backup, whitelist re-verification, small real payment and refund reconciled,
then each currency switch opened independently.

All switches default off. `STABLECOIN_ENABLED=false` and both currency flags
false, and turning a switch off must not stop the scanner, pending fulfilment
or refunds — the config shape in §14 is adopted as written.

## 4. Not in v1, restated for the record

No receiving contract, no ERC-20 allowance, no server-held private key, no
exchange withdrawals as proof of payment, no smart-contract wallets, no
sponsored transactions, no other chain, no bridging, no auto-conversion, no
stablecoin balance top-up, no user withdrawal, no third-party seller split, no
auto-renewal. CREATOR and STUDIO stay on Stripe.

No AI session in this repository initiates a real-funds transaction or asks for
a seed phrase. Refunds in v1 are drafted by the system and signed by hand on a
hardware wallet.

## Appendix: deviations taken, with reasons

Recorded as they are made, so the specification can be reconciled against what
exists rather than against what it asked for.

| Specification | Built | Why |
| --- | --- | --- |
| `POST /api/orders/:id/stablecoin-quote` | `POST /v1/payments/stablecoin/quote`, which creates or reuses the order | Routes here are `/v1`. More importantly no order exists before the quote: the card path creates the order and the Stripe session together, so there was nothing to quote against. The quote endpoint takes `priceKey` + `idempotencyKey` and is subject to the same `(user, key)` uniqueness and the same product-mismatch guard as the card path |
| `(chainId, payer, nonce)` permanently bound to an intent | `(chainId, payer)` bound while open, nonce recorded as evidence | §1 of this document. A nonce in another wallet is predicted, not reserved |
| `payer_nonce` assigned at prepare time | `predicted_nonce` is NULL until the RPC client exists | Honest null rather than a number nothing read from the chain |
| `start_block` set when quoting | 0 until the RPC client exists | "Look from the beginning" is slow and correct; an invented height would make the scanner skip a real payment |
| USDC available behind its own switch | Switch exists, and enabling it is refused at startup | There is no rate provider, and §6 forbids a hardcoded fallback. The switch cannot be turned on into a state that would quote wrongly |
| Order states `pending_payment → paid → fulfilled` | Existing `pending/paid/...` plus `entitlement_granted_at` | Fulfilment was never a status here; adding a parallel vocabulary would leave two sources of truth |

### Fixtures that did not match production

The test harness seeded the catalogue in USD (499 / 999 / 2999) while
`apps/api/src/seed.ts` seeds JPY (980 / 1,980 / 3,980). Harmless for tests that
only need a consistent number, and not harmless at all for anything that
converts a price — a stablecoin quote inheriting it would have had its
arithmetic verified against $4.99. The harness now seeds JPY; four assertions
and two Stripe webhook fixtures moved with it, one of which had been
describing a 499 refund against what is now a 980 order.

The unit counts in the harness are still not production's (100 and 400 against
15 and 45). A great many tests assert on credit balances, so that is a separate
change; it is written down here rather than left implied.

## Choosing the two RPC endpoints

§8 requires two independent nodes and a verified `finalized` tag. Two things
決めなければならない, and one of them is not a preference:

**The primary and the secondary must be different companies.** Two endpoints
from one provider usually share a cluster and a view of the chain, so a
disagreement check between them detects nothing — it looks like a safety
property and is a formality. This is not about uptime; it is about whether
"the nodes disagree" can ever be true.

**Every candidate must be probed before use.** `deploy/stablecoin/probe-rpc.sh`
takes a URL and checks chain id, the `finalized` tag, an `eth_getLogs` range
and JPYC's on-chain `decimals()`. It never prints the URL.

The check that matters most is one this project nearly shipped without. A
provider that has not implemented Heimdall v2 milestone finality can answer
`finalized` with its own `latest`: the call succeeds, the JSON shape is right,
nothing errors, and settlement then runs on probabilistic confirmations while
the code believes it has finality. `probeFinality` had three failure cases —
error, null, above-latest — and not that one, which is the one that actually
happens. Polygon's documentation puts milestone finality at 2–5 seconds
against 1–2 second blocks, so a correct node always trails its own head;
equality is the signature of the silent default.

One operational constraint the scanner inherits: providers cap `eth_getLogs`
block ranges, and the caps differ by provider and plan (one entry plan
publishes 500 blocks). `nextScanWindow`'s `maxSpan` has to be set below the
lower of the two providers' caps, or the first catch-up scan after a gap fails
on the provider rather than on anything in this code.

No provider is endorsed here, and none has been tested from this repository —
the container this work was done in cannot reach a Polygon endpoint at all.
The probe script exists precisely so the claim comes from the endpoint instead
of from a vendor's documentation.
