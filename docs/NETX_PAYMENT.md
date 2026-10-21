# Paying with NETX

Status: in progress, 2026-10-21. Decisions below were made by the product
owner on that date; the open items at the end are not decided.

## 1. What and why

NETX is the token of the NETX community, the code's upstream steward
(GOVERNANCE.md). Accepting it lets the community pay for YUHA with the
token it already holds. It is added as a fourth way to pay, next to card,
JPYC and USDC, under the existing rule (docs/PAYMENTS_DESIGN.md): what you buy
and how you pay are separate, and a token cannot renew a subscription.

| | Card | JPYC | USDC | NETX |
| --- | --- | --- | --- | --- |
| Top-up pack | ✓ | ✓ | ✓ | ✓ |
| Subscription | ✓ | ✗ | ✗ | ✗ |
| Song licence | ✓ | ✓ | ✓ | ✓ |

Nothing in that table is written per product: NETX joins the token rail, and
the matrix in `apps/api/src/services/payment-methods.ts` follows.

## 2. The token

| | |
| --- | --- |
| Name / symbol | NetX Token / NETX |
| Chain | BNB Smart Chain mainnet, chain id **56** (BEP-20) |
| Contract | `0x4c32964715e9a42F8d119bFA8917d57822d3aDF1` |
| Decimals | **unconfirmed** — read from the contract before launch (§7) |

Where the contract address comes from, so it can be checked again: it is
the one CoinRanking and CoinLore list for NETX on BSC, with the community's
own links (`x.com/netx_world`, `linktr.ee/netx_world`, `t.me/netx_dao`) and
the BscScan token page; DexPaprika and Bitquery show the same contract with
NETX/USDT liquidity on PancakeSwap. netx.world itself renders client-side and
states nothing a fetch can read. Confirm on BscScan before turning NETX on.

Unlike JPYC and USDC, NETX is **not a stablecoin**. Its market price moves,
which is why §3 and §4 exist. Interface copy says "digital currency" /
"暗号資産" where it used to be able to say "stablecoin".

## 3. Price: fixed, 1 NETX = ¥20

Decided: a fixed rate, not a market rate. A product priced ¥980 costs
980 / 20 = 49 NETX; the atomic amount is rounded **up**, so a price never
costs less than its yen value:

    amountAtomic = ceil(priceJpy × 10^decimals / 20)

Integer arithmetic only (the same rule USDC follows): no floating point
touches an amount.

On the day this was decided the market price was about $0.148, roughly
¥22–23, so paying in NETX costs the buyer slightly more than paying in yen.
If the market falls below ¥20 the opposite holds, and NETX bought on the
market buys credits below their yen price. That is accepted, with the
switch in §4 as the control.

## 4. The pause switch

An operator can stop NETX payments from the console, immediately, without a
deploy or a pod restart — a runtime switch, like the existing ones, which
can only narrow what configuration allows. While it is off:

- NETX does not appear as a way to pay, and new NETX quotes are refused;
- quotes already issued keep their window: a buyer who has been shown an
  amount and sent it is still credited. Switching off must not strand money
  that is already on its way.

## 5. Two chains

Until now every stablecoin path assumed one chain (Polygon). NETX lives on
BSC, so the chain becomes a property of the token, and everything that was
per-deployment becomes per-chain:

- two RPC endpoints per chain, from two different providers, cross-checked
  exactly as on Polygon (`STABLECOIN_RPC_MODE` and STABLECOIN_RPC_MODE.md);
- a scanner loop and a scan cursor per chain (`chain_cursors` is already
  keyed by chain id);
- the receiving address: the same EOA as on Polygon (decided — it is an
  ordinary wallet, so the same key controls it on BSC). It must never be a
  contract wallet that exists only on one chain;
- wallet ownership is proved per chain;
- the web wallet page switches the wallet to the token's chain.

BSC supports the `finalized` block tag (BSC JSON-RPC docs), so the scanner's
finality rule — only finalized blocks are believed — carries over unchanged.
Blocks are ~0.75 s, so a pass covers more blocks per minute than on Polygon;
the range splitting from PR #14 keeps a capped provider working.

## 6. Where the code changes

(Filled in from the code survey.)

## 7. Before NETX is switched on

1. Read `decimals()` from the contract (BscScan "Token Contract (WITH n
   Decimals)", or an `eth_call` of `0x313ce567`) and set it in the token
   registry. The worker also checks it against the chain at start and refuses
   to scan on a mismatch, and quoting refuses until that check has passed.
2. SRE provisions two BSC RPC endpoints from two providers.
3. Configure, in both api and worker ConfigMaps: the BSC RPC pair, and
   `STABLECOIN_NETX_ENABLED=true`. Restart both.
4. One small real payment (a DROP pack, 49 NETX), checked against BscScan
   and against the order in the console, before announcing it.
5. The 特定商取引法 page and the Terms describe the accepted payment methods;
   adding a non-stablecoin token is a change to reviewed legal text and goes
   to counsel.

## 8. Not decided here

- Refunds in NETX: handled by hand, like JPYC and USDC.
- Accounting treatment of NETX received (暗号資産 at fair value): the
  operator's accountant.
