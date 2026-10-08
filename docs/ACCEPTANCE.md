# Acceptance

A human pass over the product on one machine. Everything here can be done in
demo mode with nothing filled in; the sections marked **needs credentials** say
what to put in `.env` first.

```bash
cp .env.example .env     # only on a fresh checkout
pnpm bootstrap           # containers, migrations, seed, audio fixtures
pnpm preflight           # what is missing, and the command that fixes it
pnpm dev                 # api + worker + web
```

`pnpm preflight` prints which integrations are real and which are simulated, so
a completed pass always knows what it actually exercised. `pnpm acceptance`
runs the preflight and then `pnpm dev`.

Sign in at <http://localhost:5173/auth> with `creator@example.jp` (10 credits),
`empty@example.jp` (none), or `admin@example.jp`.

---

## How to read this

Every item is a **promise the interface makes**. Check the promise, not the
render. A screenshot and a passing typecheck say the page drew; they do not say
the thing it says is true. The composer told users "your work is saved" for
three commits while a race wiped the draft on every mount, and every check run
against it passed, because every check was about the rendering.

So: reload, read the ledger, cancel the thing, open the page in another
language.

---

## 1. Writing and generating

| # | Promise | How to check it |
| --- | --- | --- |
| 1.1 | The score is your words, not decoration | Type on `/` and watch the band change as you type. Clear the box — the ghost example returns. |
| 1.2 | "Your draft is saved" | Write on `/create`, **reload the page**. The prompt, title, lyrics, styles and length all come back. |
| 1.3 | A draft survives leaving for checkout | Write on `/`, click through to `/pricing`, come back. Still there. |
| 1.4 | Folded settings are hidden, not forgotten | Set a title, collapse **更多设置**. The badge shows a count. Reload — the panel reopens because something is set. |
| 1.5 | One credit, one song | Note the balance, generate, watch it fall by exactly one. |
| 1.6 | Progress is real, not a timer | The phase rail advances with the job. It never moves while nothing is happening. |
| 1.7 | A failed generation costs nothing | Hard to force in demo. If you see one, the balance must be unchanged and the message must say so. |

## 2. Editing a song

| # | Promise | How to check it |
| --- | --- | --- |
| 2.1 | A rewrite only offers what it actually changes | Open a song → edit. There is no length or vocals control, because the server keeps the original's. The page states what carries over. |
| 2.2 | A rewrite never eats your draft | Write a draft on `/create` first. Go to a rewrite, then leave it **using the nav, not the cancel button**. Your draft is intact and still saves. |
| 2.3 | The original survives | After a rewrite, the original song is still in the library. |

## 3. Money

| # | Promise | How to check it |
| --- | --- | --- |
| 3.1 | `/pricing` renders | It was a blank white page for eight days. Open it. Four plans. |
| 3.2 | Prices are in one currency, tax-inclusive | Every price reads `¥…`, including the free plan. No `$` anywhere. |
| 3.3 | The licence is not a plan | No "Licence" card in the grid, and the only "buy credits" button is on DROP. Licensing lives on a song page. |
| 3.4 | The confirmation screen states the real price | `/checkout/confirm?price=drop_5` shows **¥980（税込）**, not `$9.80`. |
| 3.5 | A lost order id explains itself | Open `/checkout/complete` with no query string. It says it cannot identify the order and offers billing — it must not be blank. |
| 3.6 | Credits arrive, and are recorded | Complete a simulated purchase. Balance rises; `/settings/billing` lists the order. |
| 3.7 | "Cancel anytime" | **needs credentials.** With a subscription, cancel it, and confirm it stays usable to period end. |

## 4. Three languages

| # | Promise | How to check it |
| --- | --- | --- |
| 4.1 | The whole product switches | Set 日本語, then English. Walk `/`, `/create`, `/library`, `/pricing`, `/settings/billing`, `/help/rights`, `/tracks/:id/export`, `/admin`. No stray Chinese or Japanese in an English page. |
| 4.2 | Sentences read correctly, not word-by-word | On `/help/rights` in Japanese the privacy line must end `…プライバシーポリシーをご覧ください。` — the verb comes after the link. |
| 4.3 | The statutory page stays Japanese | `/legal/tokushoho` is Japanese in all three languages. That is deliberate, not a bug. |
| 4.4 | Nothing is missing | `pnpm check:i18n` — key parity, placeholder parity, keys used but undefined. |

## 5. Failure

| # | Promise | How to check it |
| --- | --- | --- |
| 5.1 | A crash degrades to a panel | Temporarily `throw new Error('probe')` at the top of a page component. Nav and footer survive, the panel offers reload and home. Remove it afterwards. |
| 5.2 | A crash is recorded | After 5.1: `docker exec loopscene-mysql mysql -uloopscene -ploopscene_local_dev loopscene_dev -e "SELECT props FROM analytics_events WHERE name='client_error'"`. One row, with the route and component — and **no user id, no URL query**. |
| 5.3 | An unknown route says so | `/nonsense` shows "page not found", not a blank page. |
| 5.4 | The API refuses an illegal configuration | Set `RUN_MODE=production` with the demo music adapter. `pnpm dev:api` must refuse to boot and name the reason. Put it back. |

## 6. Rights and law

| # | Promise | How to check it |
| --- | --- | --- |
| 6.1 | A rights claim needs no account | Sign out. `/help/rights` still submits and returns a case number. |
| 6.2 | 特商法 disclosure is complete or says it is not | `/legal/tokushoho` lists all statutory rows. Prices come from the live catalogue. Three rows are marked 要法務確認 — that is correct until counsel fills them. |
| 6.3 | Usage terms are recorded per song | `/tracks/:id/export` shows the usage-terms record with its audio hash. |

## 7. Phone

Set the browser to 375px wide, or use a real phone on the same network.

| # | Promise | How to check it |
| --- | --- | --- |
| 7.1 | Nothing scrolls sideways | Every page in section 1–6. |
| 7.2 | Things are big enough to hit | The language switcher, footer links, segmented controls, card overflow buttons and song titles are all at least 44px on a touch device. |
| 7.2a | …except links inside a sentence | A link in running prose (the "Privacy Policy" in the rights form's privacy note, and the same on account settings) stays inline. WCAG 2.5.8 exempts targets "in a sentence or block of text", and giving one a 44px box would overlap the lines above and below it. Two overlapping targets are worse than one small one — do not "fix" these. |
| 7.3 | The composer still leads | `/create` keeps the score, the description and one primary button above the fold. |

## 8. The scripted checks

These catch what an eye does not. All must pass.

```bash
pnpm typecheck
pnpm test          # the whole suite, needs the containers (it prints the counts)
pnpm check:i18n    # dictionaries, used-but-undefined keys, hardcoded strings
pnpm check:contrast
pnpm check:orphans
pnpm build
```

---

## What this pass cannot tell you

Say these out loud in any sign-off, because a green acceptance is otherwise
read as more than it is:

- **The audio is synthetic.** No agreement with a music provider is signed;
  `MUSIC_COST_IS_ESTIMATE` is true and every cost figure is modelled.
- **Payments are simulated** unless you filled the Stripe section, and then
  they are test mode.
- **Nothing has been deployed.** `infra/terraform` has never been applied to an
  AWS account — `docs/OPEN_ITEMS.md` records that.
- **Three 特商法 rows are unwritten**, and production refuses to boot without a
  real legal entity block, by design.
