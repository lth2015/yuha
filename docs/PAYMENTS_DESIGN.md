# Payments: the design rule

One page, because the alternative is every purchase surface deciding for
itself. Written 2026-10-20 after the pricing grid showed 「用 JPYC 购买」 on
DROP and 「银行卡支付暂未开放」 on the two subscriptions beside it: each button
had picked its own channel, from rules the server held a different copy of.

**Any change to how something is bought or paid for starts here.** If the
change does not fit this page, change this page first, in the same commit.

## 1. What you buy and how you pay are separate questions

**What you buy** — three kinds, and only three:

| Kind | Products | Renews |
| --- | --- | --- |
| Top-up pack (充值包) | DROP | no — one payment, credits valid 90 days |
| Subscription (订阅) | CREATOR, STUDIO | yes — charged every month until cancelled |
| Song licence (单曲授权) | Licence | no — one payment, one song |

**How you pay** — channels:

| Channel | What it is |
| --- | --- |
| Card (银行卡) | Stripe Checkout. Apple Pay, Google Pay, konbini, Alipay and WeChat Pay are whatever the Stripe account enables; the code never lists them |
| JPYC | Yen stablecoin on Polygon, 1 JPYC per yen by pricing policy |
| USDC | Dollar stablecoin on Polygon, priced as one US dollar at the live USD/JPY rate plus a buffer (§4) |

## 2. The matrix — the whole rule

| | Card | JPYC | USDC |
| --- | --- | --- | --- |
| Top-up pack | ✓ | ✓ | ✓ |
| Subscription | ✓ | ✗ | ✗ |
| Song licence | ✓ | ✓ | ✓ |

The ✗ has one reason: **a subscription renews by charging the buyer every
month, and a stablecoin cannot be charged — only sent.** A stablecoin buyer
who wants a month's worth of songs buys top-up packs (预充值). There is no
"stablecoin subscription", and no button may suggest one.

What a product accepts is **(channels this deployment has open) ∩ (what its
kind allows)**. Nothing is decided per price key: a new one-time product is
payable in every open channel the day it is added, and a new channel is
offered on every product its kind allows.

## 3. Where the rule lives, and who may read it

- **Computed once, on the server:** `apps/api/src/services/payment-methods.ts`.
  It produces `ProductView.paymentMethods` for every product in
  `GET /v1/products`: each channel with `available` and, when it is not, a
  `reason` (`card_closed` or `no_auto_renewal`).
- **Enforced by the same code:** the stablecoin quote endpoint refuses a kind
  the rule does not allow (`stablecoinAllowedFor`), and the card endpoints
  refuse with `CARD_PAYMENTS_CLOSED` when the card channel is closed.
- **Rendered, never decided, in the browser:** `apps/web/src/lib/purchase.ts`
  only lists what it was given.

A list of price keys anywhere else that says which product may be paid how is
a defect — there were three (the quote service, the quote route's schema, and
the browser), and they are why the grid disagreed with itself.

## 4. USDC pricing

- **Price:** `ceil(JPY list price × (1 + buffer) ÷ USD/JPY × 10^6)` atomic
  units, in integer arithmetic (`packages/providers/src/chain/quote.ts`).
  Rounded up: an underpayment of one atomic unit ends in manual review.
- **Rate:** USD/JPY, because one USDC is priced as one US dollar (decision of
  2026-10-20). Read live on every quote from two independent sources
  (`packages/providers/src/fx/usd-jpy.ts`):
  - Coinbase's public exchange-rate table — intraday, **priced from**;
  - Frankfurter's blended central-bank reference — daily, **cross-check only**.
- **Refused, not approximated,** when either source cannot be read, the
  reference's publication is older than `STABLECOIN_RATE_REFERENCE_MAX_AGE_HOURS`,
  or the two differ by more than `STABLECOIN_RATE_MAX_DIVERGENCE_BPS`. The
  refusal happens before any order or quote row exists.
- **Buffer:** `STABLECOIN_USDC_BUFFER_BPS`, 100 (1%) by decision, to cover the
  rate moving during the quote's lifetime.
- **Recorded on every quote:** the rate as the source wrote it, its source and
  read time, the buffer applied and the reference it was checked against —
  so the price can be defended later regardless of what the configuration
  says by then. The buyer sees the rate and the buffer next to the amount.
- JPYC consults no rate and takes no buffer.

## 5. What the screens do

1. **Plan cards say what you buy, never how you pay.** One button per card:
   「购买」 or 「订阅」. No channel names on a card.
2. **Every purchase goes through the confirmation screen**
   (`/checkout/confirm`), which also states the seller, renewal and
   cancellation terms before the obligation arises. There the buyer picks a
   channel from the product's `paymentMethods`. Unavailable channels stay
   visible, disabled, with their reason.
3. **The pricing page states the accepted channels once,** under the plans,
   derived from the same data as the buttons.
4. **When nothing can pay for a product,** its card says 「暂不可购买」 and the
   one reason — and for a subscription with only stablecoins open, points the
   buyer at top-up packs.
5. A channel being closed is stated where a channel is chosen, not as a
   banner over products.

## 6. Not decided by this page

Stripe customer-portal features (saved cards, card updates, resuming a
cancelled subscription, plan changes) are a separate piece of work; when they
arrive, they change how the card channel behaves, not this matrix.
