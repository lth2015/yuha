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
| DROP 980 / CREATOR 1,980 / STUDIO 3,980 / Licence 980 JPY | Matches `apps/api/src/catalogue.ts` exactly, `currency: 'jpy'`, tax-inclusive | No conflict. **But** `tests/helpers/harness.ts` seeds the catalogue in USD at 499/999/2999 — a stablecoin test that inherits that seed would verify quote arithmetic against $4.99. Stablecoin tests seed JPY explicitly |
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
`apps/api/src/catalogue.ts` holds JPY (980 / 1,980 / 3,980). Harmless for tests that
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

## Phase D: what a local chain proved, and what it could not

The suite runs against fake nodes almost everywhere, which is right for
arranging a reorg or two nodes at odds and wrong for one thing: a fake agrees
with whatever the code believes about encoding. `tests/stablecoin-local-evm.test.ts`
runs the path against an actual EVM — a mock ERC-20 compiled from
`tests/fixtures/evm/MockToken.sol`, deployed on an in-process chain, with real
calldata execution, real Transfer logs and real receipts.

Three things it established that the fakes could not:

**The local EVM serves `latest` for `finalized`.** Confirmed at block 12, not
at genesis where equality would prove nothing. That is the silent failure the
probe had no check for until a provider's documentation was read, and here it
is a real implementation exhibiting it rather than a fake arranged to. The
probe refuses it.

**Eighteen decimals and six are different numbers, against two real
contracts.** Quoting a six-decimal token as eighteen overpays by 10^12 and the
other way underpays by the same; both are "a number" and both read fine in a
log line. Each contract was deployed with its own `decimals`, paid, and its
balance read back.

**A perfect payment of an unwhitelisted token is refused.** This test was
written expecting `fulfil` and cannot reach it, which is the finding: the
whitelist is two addresses compiled into the code rather than a runtime input,
so a mock is refused however correct the payment is — right sender, right
recipient, right amount, real receipt, real log, matching nonce. Making the
whitelist injectable would have let the test say `fulfil` and would have
turned the one thing that cannot be faked into something a configuration
mistake could widen.

One mechanical note worth keeping: the mock is compiled with `evmVersion:
'paris'`. Current solc emits `PUSH0`, which the local EVM does not implement,
and the deployment then consumes exactly its gas limit and reverts — a
signature that reads like "needs more gas" and is not.

**What phase D does not cover.** Nothing here touches a mainnet address, and
the mock is a mock: not a stablecoin, not redeemable, not a representation of
JPYC or USDC. Milestone finality, real provider behaviour under load, and
`eth_getLogs` range caps are all properties of the production endpoints and are
established by `deploy/stablecoin/probe-rpc.sh` against those endpoints, not
here.

## The third review, and the defect that produced a table

Four independent adversarial reviews ran against the finished code, in
parallel, with instructions to verify claims against the source rather than
against comments and to produce working proofs. They returned 21 findings, six
of them able to take a customer's money and deliver nothing, permanently and
silently. 675 tests were green at the time and four gates were clean.

**One design mistake produced the worst six.** `chain_transfer_events` has a
unique key on `(chain_id, tx_hash, log_index)`, and that key is the anti-replay
claim for the whole feature: one Transfer pays for one order, once, ever. The
previous round started writing rows there for money that was *not* being
attributed — a transfer from a wallet with nothing open, and a transfer the
verifier refused that nonetheless really paid us. The intention was right: money
that arrives must be on the record. The place was wrong. Taking the anti-replay
key for a row that delivers nothing means the real payment can never settle
afterwards: every later observation answers `already_settled`, the order stays
pending, and nothing in the console could attach it.

Three ordinary sequences reached that state, none needing an attacker:

- A payment made **inside** the quote window, first seen after it closed —
  because the scanner reads finalized blocks on an interval — met an intent the
  new expiry sweep had just closed, and was orphaned.
- Any refusal computed from the transaction body (`token_not_quoted`,
  `unexpected_value`, `calldata_not_transfer`) wrote the row and left the
  intent open, so the customer's correct re-payment of the same transfer could
  never settle.
- A compromised RPC endpoint altering **one field** — `from` on
  `eth_getTransactionByHash` — turned a real payment into unattributable money,
  because attribution read that field before the verifier ran and nothing
  compared it with anything.

The record of money arriving and the claim on a payment are two different
facts. They now live in two tables: `stablecoin_orphan_transfers` holds the
first and claims nothing, and a transfer may appear there on one pass and
settle normally on a later one. `POST /v1/admin/stablecoin-transfers/:id/decide`
is the repair path that did not exist — attach to an order, or write off — and
it runs the same settlement the scanner does, with a reason and an audit row.

### The rest, in one line each

- Attribution now uses the **agreed Transfer log's** sender, not the
  transaction's; the transaction body itself is dual-node agreed
  (`agreedTransaction`), so the refusal reasons are trustworthy too.
- Discovery takes the **union of both nodes'** `eth_getLogs`. One node omitting
  a payment from one answer used to lose it with no row anywhere — the only
  invisible way to lose money in this design.
- The scan no longer `break`s on a transfer it cannot agree about: it holds the
  cursor and keeps going, so one fabricated log cannot stop every pass forever.
- `agreedHeader` compares the block **number**; `agreedReceipt` compares each
  log's own transaction hash and block, and normalises the order it returns.
- `eth_chainId` is actually called now, for both endpoints, at startup. A
  comment claimed that for a week while nothing in the repository called it.
- The decimals check runs on the **quote path** as well, memoised, because the
  API is what prices and delivers; a mismatch latches, a timeout retries.
- Quote expiry holds the wallet slot for `STABLECOIN_INTENT_GRACE_SECONDS`
  (default 15 minutes) past the deadline, and the sweep runs after the scan.
- `start_block` with no cursor is a **refusal**, not block zero.
- One order holds one live payment slot, enforced by `order_open_key`.
- A rejected review records `refund_owed_at`; a duplicate licence is reported
  by `grantLicense` instead of being marked delivered.
- `markOrderPaid`'s `changed` is read in the console too, and a settlement that
  cannot move an order leaves the intent **in review**, where a person sees it.

### A driver-level trap worth remembering

`grantLicense` decided "did I write a row" from `affectedRows` on an
`INSERT ... ON DUPLICATE KEY UPDATE id = id`. This driver connects with
CLIENT_FOUND_ROWS, so that statement reports `affectedRows: 1` when it inserted
nothing: the flag was **always true**. Nothing noticed while the caller threw it
away — and the fix for the duplicate-licence defect was built on it, so the
detection would have detected nothing while looking tested. `INSERT IGNORE`
does report 0, which is why the evidence key is sound; the two forms differ.
Found by writing the test, not by reading the code.

### What is still not covered, stated plainly

- There is no automated stablecoin refund. `refund_owed_at` records the
  obligation; a person signs the transfer on a hardware wallet (§13).
- `chain_transfer_events.canonical` defaults to 1 and nothing ever sets it to
  0. Settlement only happens at or below a height both nodes call final, so a
  reorg deep enough to matter would need manual unwinding.
- The reject branch's two writes are now in one transaction, but the
  crash-between-writes property is reasoned, not demonstrated: no test can
  produce the crash.
- `probeFinality` rules out answers that are not this chain and cannot prove
  milestone finality. Lag alone cannot distinguish it from one confirmation —
  run `deploy/stablecoin/probe-rpc.sh` against the real endpoints and read the
  provider's documentation.
- `orders.payment_method = 'card'` is never written by anything today, and the
  column's collation accepts `'CARD'` while the JavaScript comparison does not.
  Inert now; a trap if something starts writing it.

## The front end, and what it refuses to do

Until now this channel existed only as HTTP endpoints: the backend could take a
payment and the browser had no way to make one. `/checkout/stablecoin` is that
flow, reached from a payment-method choice on the confirmation screen, which
appears only when `GET /v1/runtime` says the channel is on **and** the product
is one the quote endpoint accepts (DROP and Licence — a wallet button on a
subscription would be an offer the next request refuses).

Wallet support is deliberately narrow for a first version: an injected
EIP-1193 provider, which means a desktop browser extension. WalletConnect
would add a third-party dependency and a project registration, and the
manual-transfer fallback cannot stand alone because proving the wallet still
needs a signature from it. A customer without an extension is told so plainly
and offered the card path, rather than being walked into a flow that cannot
finish.

The decisions live in `apps/web/src/lib/stablecoin.ts` as pure functions —
amount formatting, the step order, wallet error codes, network parameters — and
are tested without a browser in `tests/stablecoin-pay-ui.test.ts`. The page
renders them. What that separation buys is that the following are tested rather
than hoped for:

- **The figure shown is the figure sent.** Atomic units are formatted from the
  string with the quote's own `tokenDecimals`; 980 JPYC is 980000000000000000000
  atomic units, which a double cannot hold. A mutation that formats through
  `Number` is killed by a test, and so is one that renders an amount it was
  not given.
- **A sent transaction is not a finished purchase.** `done` is delivery, read
  back from the server. A transaction can revert, land short, or sit in a block
  that is not final.
- **No signature prompt on the wrong network**, because that prompt cannot lead
  anywhere; and no quote before the wallet is proved, because the server would
  refuse it. Both would read as a broken page rather than a step out of order.
- **No invented networks.** `wallet_addEthereumChain` is only offered for a
  chain whose parameters are checked into the repository. A fabricated RPC URL
  is a lasting piece of wrong configuration left in somebody's wallet.
- **No wallet's own English shown to a Japanese customer.** Every provider
  error becomes a dictionary key, including the one that matters most —
  `-32002`, a request already waiting in a wallet window behind the browser,
  which otherwise looks like the page having frozen.

Three currency lists became one while doing this. The quote service had a
`SUPPORTED` map, the scanner had a pair of `tokenByKey` calls, and the runtime
descriptor would have been a third — the shape that has produced five defects
in this codebase. `apps/api/src/services/stablecoin-tokens.ts` is now the only
place that filters the whitelist by chain and by switch, and the switch lookup
is a `Record` over the key union, so adding a currency fails to compile until
somebody says whether it has a switch.

### The operations console

Four things an operator can now do, each of which existed only as an endpoint:
decide a payment in review, attach money that could not be attributed to an
order (or write it off), see what refunds are owed, and download the monthly
reconciliation file. For a defect whose whole cost was a stranded payment that
nobody could repair, "usable but not clickable" was barely better than absent.

Three decisions inside it are worth naming:

- **Precision comes from the runtime descriptor, never from the bundle.** The
  review rows carry a token key, not a number of decimals, and an operator
  judging whether a payment is one unit short must not be reading a figure the
  browser scaled by itself. A currency the page was not told about shows raw
  atomic units — a long number is obviously raw, where a wrongly scaled one is
  not.
- **The month is a JST month.** `paid_at` is stored in UTC, and the month a
  税理士 reconciles is a Japanese calendar month, so UTC boundaries would put
  nine hours of 1 October into September's file and leave nine hours of
  31 October out of October's. Japan has no daylight saving, so the offset is a
  constant. A mutation that uses UTC boundaries is killed by a test.
- **The reason is a field in the row, not a `window.prompt`.** The rights-case
  console asks for its reason through a modal; a mandatory reason typed into a
  box that cannot be reviewed or corrected is one people learn to type "ok"
  into, and the audit row is the entire point of asking.

The CSV goes through a fetch and a Blob rather than a link, because the
endpoint needs the bearer token — a plain `<a href>` would have downloaded an
HTML error page named `.csv`. That required a text-returning sibling of
`apiFetch`; both now share one request and one error path, rather than a second
copy of the authorization header and the 401 handling for the one of them
nobody tests.

### Still missing from the front end

- **Mobile wallets cannot pay.** No `window.ethereum` in a mobile browser, and
  no WalletConnect.
- **Neither page is component-tested.** There is no React testing setup in this
  repository. The decisions are pure functions with tests and mutation
  coverage — amount formatting and comparison, the step order, wallet error
  codes, network parameters, the JST month, who may decide — but the wiring
  between them and the markup is reasoned, not demonstrated. Where a guard has
  to hold for both the action and the rendering, it is one shared expression so
  that there is nothing to keep in step; that is the strongest claim available
  here, and it is weaker than a test.
- **Attaching money to an order is done by pasting an order id.** There is no
  search: an operator finds the order elsewhere in the console and copies it.
  Deliberate for a first version — the action is rare and the consequence of
  attaching the wrong order is a wrong delivery — but it is a sharp edge.
