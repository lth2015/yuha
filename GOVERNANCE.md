# Governance

YUHA's code is donated to the **NEXT technical community**
(<https://www.netx.world/>), which becomes its upstream steward. The service
that sells songs at yuha.studio is **not** donated and keeps running under its
present operator. This file exists to keep those two from being confused later,
because nearly every obligation the product carries attaches to the second one.

## What the steward has

Under the donation, the steward takes the project: the canonical repository,
and with it the decisions about what is merged, what is released, and on what
terms contributions are accepted. The licence is Apache-2.0 (`LICENSE`); what
that licence covers, and what it deliberately does not, is in `NOTICE`.

Written on 2026-10-08, while the work still happens in the operator's own
repository. What the agreement says, and the date the canonical repository
moves, are matters for the agreement and not for this file — so if you are
reading this to find out where upstream *is*, ask, rather than inferring it
from a remote.

NEXT's own legal particulars — the steward's registered name, its seat, its
registration number, its legal form — are **deliberately not written anywhere
in this repository**. netx.world, read on 2026-10-08, publishes none of them,
and the donation agreement is the document that names them. Nothing here
should be read as a statement about that entity, and nobody should fill these
in from memory: if a file needs them, take them from the executed agreement.

## What the steward does not have

yuha.studio is a commercial service operated independently of the steward.
Concretely, and in the places it matters:

- **The money.** The Stripe account belongs to the operator. Every charge,
  refund and chargeback is the operator's, settled to the operator's bank.
  The steward is not a party to any customer's purchase.
- **特定商取引法.** The 販売業者 and 運営統括責任者 named on
  `/legal/tokushoho` are the operator's, as are the address, telephone number
  and contact address on that page.
- **Personal data.** The controller named on `/legal/privacy` is the operator.
- **Consumer obligations.** Cancellation, refunds, support and the statutory
  disclosures are the operator's to honour. Donating the code moved none of
  them.

Those strings are rendered from configuration — `LEGAL_ENTITY_NAME`,
`LEGAL_ENTITY_REPRESENTATIVE`, `LEGAL_ENTITY_ADDRESS`, `LEGAL_ENTITY_CONTACT`,
`LEGAL_ENTITY_PHONE`, served by `GET /v1/legal/business-disclosure` — and no
default can name anybody: unset fields render as `(not configured)` behind a
banner that says so. Production refuses to start without `NAME`, `ADDRESS` and
`CONTACT`; `REPRESENTATIVE` and `PHONE` are not required by `loadConfig` even
though the statute asks for them, so the 特商法 page marks each of those
**要法務確認** when it is missing rather than printing a blank statutory field.
Anyone who runs this software is the operator of their own deployment and
supplies their own.

`scripts/check-stewardship.mjs` (`pnpm check:stewardship`) enforces the parts
of this that are mechanical, and its header is explicit about the parts that
are not: every operator-identity value on every disclosure surface must be an
interpolation of what that endpoint served, none of those surfaces may name the
steward, and the operator's own values must appear in no tracked file outside
`deploy/envs/`.

## The operator's details are in this repository today

They are in `deploy/envs/production.yaml`, `staging.yaml` and `qa.yaml`, which
are tracked. The operator is a sole proprietor, so those five fields are one
person's legal name, home address, telephone number and personal email.

So this is not true and must not be written anywhere: *"the repository does not
name the operator"*. It does, in three files, and publishing the repository as
it stands publishes a home address. They were removed from everywhere else —
`.env.example`, five documents, a deploy script, a lyric fixture and the SEC-13
test each carried some of them — and the check above keeps them from spreading
again, which is a different thing from making the repository safe to publish.

Before this repository is public anywhere, the `legal:` block has to move out
of those files into the secret store, the way every other secret already does
(`deploy/cluster/external-secrets.yaml`). That is infrastructure work, it is
recorded as a blocking item in `docs/OPEN_ITEMS.md` §8, and it is the one thing
on this page that is not yet done.

## Contributions

Inbound contributions are under Apache-2.0 on the same terms as the project
(Apache-2.0, section 5) unless the steward adopts a CLA or a DCO. Which of
those applies is the steward's call and is not settled here; when it is
settled, it is recorded in this file and in `CONTRIBUTING.md`. Until then
nobody should claim a sign-off requirement that does not exist, and no
pull-request template should imply one.

## What counsel may still want to change

Recorded here so none of it is discovered by accident. All four are also rows
in `docs/OPEN_ITEMS.md` §8.

1. **The copyright line.** `LICENSE` and `NOTICE` both say
   `Copyright 2026 YUHA contributors`. If the donation agreement assigns
   copyright to a named entity, both become that entity's. The site footer
   separately renders `© <year> YUHA` from `footer.made` in
   `apps/web/src/lib/i18n.tsx`, in all three languages, which is a product
   string rather than a licence header but would read oddly if it disagreed.
2. **SOUNDRAW's agreement text.** `NOTICE` carves the third-party documents out
   of the Apache grant, which fixes the licensing claim. It does not answer
   whether `spec/API Pro Plan - API General Agreement & Licensing terms.md` may
   be published at all; if it may not, the file has to leave the repository
   before the repository becomes public.
3. **The name and the marks.** Apache-2.0 grants no trademark rights, so the
   name YUHA and its marks do not travel with the code by default. Whether
   they transfer is for the agreement.
4. **The operator's details**, as above — the only one of the four that is
   engineering work rather than a drafting decision.
