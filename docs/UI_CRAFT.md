# The craft standard

> Reviewed against **Suno** (<https://suno.com>) on **2026-09-26**, at 1024px
> and 375px. Supersedes the competitive section of
> [UI_DESIGN.md](UI_DESIGN.md), which reviewed Suno on 2026-09-10 against a
> product — light palette, 30-second instrumental — that no longer exists.

The brief for this round was explicit: **not more features than Suno, better
detail than Suno.** So this document is not a restyle. It is the standard the
product is held to, and every rule in §4 is written next to the defect it would
have caught in our own code.

The honest headline: we went looking for polish gaps and found that **the
pricing page had been a blank white screen for eight days**. Craft is not the
layer above correctness. It is correctness, noticed.

---

## 1. What Suno does that is worth learning

Facts read from the live page, not impressions.

### 1.1 The headline *is* the input format

The `<h1>` is a typewriter that types out example prompts — "Make a jazz song
about watering my plants", then "Make a house song about quitting your job" —
and the composer sits directly under it. The page teaches you what to type by
being what you'd type. Measured: `h1.textContent` changed from `"Make a house"`
to `"Make a house song about quitting your job"` across a 1.5s sample.

Our hero separates these into a brand slogan (让心动，有回声。) and a
placeholder. The slogan says what the product *means*; it does not say what to
write. The mood chips do that job, but they are below the fold of attention.

### 1.2 The composer is one line until you ask for more

`+` (attach) · **Advanced** · randomise · **Create**. Four controls, one row,
everything else behind Advanced. Their landing composer is *more* converged
than our `/create` studio — and ours is now the converged one of our two.

### 1.3 One saturated thing on screen

Exactly one gradient button. Everything else is translucent white. We follow
the same rule with `--petal`; worth keeping deliberate rather than accidental.

### 1.4 Free tier as a *daily* allowance

"50 credits per day", not a one-time grant. A daily refill gives a reason to
come back that a one-time grant cannot. We currently ship
`FEATURE_FREE_TRIAL_ENABLED=false`, which means a documented setup gives new
users **zero** credits — see §5.

---

## 2. Where we are already ahead, measured

The same instrument, pointed at both. Suno's landing, 2026-09-26:

| Check | Suno | YUHA |
| --- | --- | --- |
| `<h1>` per page | **3** ("Make a house song…", "Mind blowing song quality", "Everything you need…") | 1 |
| Heading used for size, not structure | `<h2>` as hero body copy | no |
| Prompt field label | **placeholder only**, `aria-label: null` | real `<label for>` |
| Icon-only buttons with no accessible name | **the `+` button**: no text, no `aria-label`, no `title` | none |
| Icon button size | 36×36 | 44 (`--tap`) where we got it right — see §3.3 |
| Animated `<h1>` accessible name | changes character-by-character, no `aria-live`, no stable label | n/a |
| Price display | tax-exclusive, "Taxes calculated at checkout" | tax-inclusive JPY (総額表示) |

The last row matters commercially, not just ethically: Japan's 総額表示義務
requires consumer prices to be shown tax-included. Our catalogue already is.

**Not verified:** whether Suno's typewriter respects `prefers-reduced-motion`.
It is JS-driven, so a CSS media query would not stop it, and reading their
minified bundle to find out is guesswork. Recorded as unknown rather than
claimed either way.

---

## 3. What the same instrument found when pointed at us

This is the part that matters.

### 3.1 `/pricing` was a blank white screen — for eight days

```
Uncaught TypeError: products.slice is not a function   (Pricing.tsx)
```

`GET /v1/products` returns `{"items": [...]}` and has since the first commit
(`62390f2`, 2026-09-10). `Pricing.tsx` was written on 2026-09-18 (`106df95`) as:

```ts
apiFetch<ProductView[]>('/v1/products').then(setProducts)
```

`apiFetch<T>` is an **unchecked cast**, so the annotation is decorative. The
object passed the `products === null` skeleton guard, reached `products.slice()`
and threw. Typecheck passed. Build passed. 127 tests passed. Two formal
`/code-review` rounds passed. Nobody opened the page.

`Checkout.tsx` fetches the *same endpoint* with the *correct* shape
(`{ items: ProductView[] }`) eleven lines of repo away.

### 3.2 The same bug on the song page, swallowed

`SongDetail.tsx` has the identical mistake inside `.catch(() => undefined)`.
It does not crash; `licenseProduct` is permanently `null`, so:

- the licence purchase button is **permanently disabled** on every song page,
- its label interpolates the price to `''`, and
- nothing is logged.

Two of our revenue paths were dead. Neither was visible as a failure.

### 3.3 A `title` that promises money we do not pay

```tsx
title={me ? '购买使用授权，创作者获得 70%' : '登录后可购买授权'}
```

Three defects in one attribute: it is a hardcoded Chinese literal in a
trilingual product; `title` is not a reliable accessible name and never reaches
touch users; and **"创作者获得 70%" promises a revenue share that migration
0005 removed.** `CLAUDE.md` records revenue sharing as a deliberately deleted
scope decision. The string outlived the feature.

### 3.4 116 hardcoded strings, and they are not all one language

The first count was 31, from a grep for quoted string literals. That grep — and
the checker written from it — could not see JSX text nodes, and the densest
block of untranslated copy in the product is written as `<th>提供時期</th>`.
The real figure, after the checker was taught to read both shapes:

| File | Hardcoded | `t()` calls |
| --- | --- | --- |
| `Admin.tsx` | **43** | 0 |
| `Export.tsx` | **25** | 2 |
| `Rights.tsx` | **23** | 0 |
| `Checkout.tsx` | **19** | 14 |
| `Project.tsx` | 6 | 0 |

`Admin`, `Rights` and `Project` are **entirely** hardcoded Japanese. `Checkout`
— the page where money changes hands — is hardcoded Japanese inside a page that
otherwise translates. A Chinese user reaches the payment step and the
cancellation terms switch language.

The first version of the checker reported "✓ no new hardcoded UI strings (22
baselined)" and passed CI. It was wrong by a factor of four, and it was wrong in
the confident direction. That is the same failure as §3.1 one level up: a check
returning a clean number is not evidence, unless you have asked what it cannot
see. Recorded as rule 10.

`Admin`, `Rights` and `Project` are **entirely** hardcoded Japanese. `Checkout`
— the page where money changes hands — is hardcoded Japanese inside a page that
otherwise translates. A Chinese user reaches the payment step and the
cancellation terms switch language.

`check:i18n` does not catch this: it verifies the dictionary is internally
consistent, not that components use it.

Also still present, the `.replace()` anti-pattern already recorded in
`CLAUDE.md` as a past mistake:

```tsx
aria-label={t('nav.skip').replace('跳到内容', '主导航')}
```

which only substitutes in Chinese. In ja/en the main navigation is announced as
"Skip to content".

### 3.5 Our own contrast note records a failure we shipped

`styles.css` says, in a comment: *"ink 18.2:1, muted 7.6:1, faint 4.3:1"*.

Recomputed against `--bg: #08090d`:

| Token | Ratio | Verdict |
| --- | --- | --- |
| `--ink` | 18.24:1 | pass |
| `--muted` | 7.59:1 | pass |
| `--faint` | **4.32:1** | **fails AA** |

4.32 would be acceptable for large text (≥18.66px). `--faint` is used at
**11–13px** in all six places it appears — two of them on the pricing page. The
number was written down, and then shipped anyway. Writing a measurement down is
not the same as acting on it.

### 3.6 The checkout screen priced a ¥980 pack at **$9.80**

`lib/money.ts` opens with a comment calling itself "the one place amounts
become text", written when three formatters were consolidated into it. It
centralised the function and kept `currency = 'usd'` as a default. Four call
sites in the checkout flow omitted the argument:

| Line | Rendered | Should be |
| --- | --- | --- |
| `Checkout.tsx:95` — the 最終確認画面 price | **$9.80**（税込） | ￥980（税込） |
| `Checkout.tsx:124` — the renewal charge | $49.80 | ￥4,980 |
| `Checkout.tsx:284` — "you paid" | $9.80 | ￥980 |
| `Checkout.tsx:373` — the simulated total | $9.80 | ￥980 |

The first of those is the screen 特定商取引法 requires to state the real price
at the moment the payment obligation is created, and it stated a different
currency — directly in front of the characters（税込）.

Centralising the formatter did not cause this and did not fix it. **The default
did.** `currency` is now required, which turned all four into build errors.

### 3.7 A render throw takes the whole app with it

There is no error boundary. One component throwing unmounts nav, footer and
content to `#08090d` — which, on a near-black design, is indistinguishable from
a page that simply has not loaded. §3.1 was invisible partly because of this.

### 3.8 Touch targets below 44px

At 375px, on every page: the language switcher (**32px**), the brand link (34px),
the sign-out row (40px), footer legal links (20px), and the vocals segment
(39px). `--tap: 44px` exists as a token and is not applied to these.

---

## 4. The standard

Each rule names the defect above that motivated it. A rule nobody can point a
scar at is decoration.

0. **A default is a decision made for every caller who forgets.**
   `currency = 'usd'` was the whole of §3.6. Where being wrong is expensive,
   require the argument and let the compiler find the call sites.
1. **A page is not done until it has been opened.** Every route, after any
   change to shared plumbing — §3.1 was eight days old and behind a link I
   built the day before without following it.
2. **A typed fetch is a claim about a server, and claims get checked.**
   `apiFetch<T>` casts; it does not validate. Either validate against the
   contracts schema or treat the annotation as a comment — §3.1, §3.2.
3. **Never swallow an error without a trace.** `.catch(() => undefined)` turned
   a crash into a permanently disabled button — §3.2.
4. **A string that names a feature dies with the feature.** Grep the copy when
   deleting scope — §3.3.
5. **Every user-facing string comes from the dictionary.** No exceptions for
   admin pages; "internal" pages have users too — §3.4.
6. **Never `.replace()` a translated string** — §3.4, and `CLAUDE.md`.
7. **A contrast number is a gate, not a note.** If it is written down and it
   fails, it does not ship — §3.5.
8. **A failure degrades to a panel, never to a blank page** — §3.7.
9. **`--tap` is a floor, applied at touch width** — §3.8.
10. **Ask a new check what it cannot see, before trusting that it saw nothing.**
    The hardcoded-string checker read quoted strings only, reported 22 and
    passed. The real number was 116. The contrast gate measured one background
    and passed a token failing on another. Both were written *in the round that
    recorded this rule* — §3.4, §5b.1, and §3.1, where "no issues found" meant
    "the page rendered nothing".
11. **A fix is finished when its comment is true.** Three separate comments in
    this round described behaviour the code did not have: a "loud and specific"
    message nothing displayed, a check that "removes the class" and removed
    half, and an empty state promised in a file before it existed — §5b.2,
    §5b.3, §5b.4.

---

## 5. Backlog, in order

| # | Item | From | Status |
| --- | --- | --- | --- |
| 1 | `/pricing` crash | §3.1 | **done** — `lib/catalog.ts`, one checked fetch for all three callers |
| 2 | Song licence purchase dead | §3.2 | **done** — same fetch; the swallowed catch now logs |
| 3 | `$9.80` on the confirmation screen | §3.6 | **done** — `currency` is a required argument |
| 4 | Error boundary | §3.7 | **done** — verified with a deliberate throw; nav and footer survive |
| 5 | The 70% tooltip | §3.3 | **done** — replaced with a translated `aria-label` |
| 6 | `--faint` contrast | §3.5 | **done** — 4.32 → 5.31:1, gated by `check:contrast` |
| 7 | Checkout pay button, Home error, Layout nav + player | §3.4 | **done** — and `check:i18n` now gates the class |
| 8 | Touch targets | §3.8 | **done** — coarse-pointer only; desktop rhythm unchanged |
| 9 | `Admin` / `Rights` / `Project` / `Export` full translation | §3.4 | **done** — 97 sites, 116 → 19 remaining |
| 10 | The 特商法 table's own strings | §3.4 | **deferred deliberately** — a statutory disclosure is a legal review, not a dictionary entry |
| 11 | The licence sits in the plans grid with a "buy credits" button | new | **done** — off `/pricing`; licensing lives on the song page, where it always worked |
| 12 | Hero teaches the input format | §1.1 | **declined** — the brand slogan stays |
| 13 | Daily free allowance vs one-time grant | §1.4 | **declined** — the one-time grant stays |

Item 9 is paid off. `scripts/i18n-hardcoded.baseline.json` now holds **19**
entries, all of them the 特商法 table in item 10. The checker also reports debt
that has been *cleared*, which it did not before: four files were translated in
full while it still printed "116 baselined", describing a codebase that no
longer existed.

One defect came out of doing it, worth recording because it is not obvious.
The privacy sentence on the rights form wraps a link:

> ご入力いただいた情報は…詳しくは**プライバシーポリシー**をご覧ください。

Japanese puts the verb last, so the sentence continues *after* the link.
Splitting it into "text + link" — which is correct for English and Chinese —
left the Japanese with no predicate at all. It needs a third, trailing key, the
way `create.pickPlanTail` already did. **A sentence cannot be split around an
inline element in a shared structure across languages.**

Item 10 is a deliberate refusal rather than laziness. Translating cancellation
and refund terms changes what a consumer is agreeing to. That needs someone
qualified, not a careful guess.

Items 9 and 10 change what the product *is*, not how well it does what it
does. They are recorded here, not taken.

---

## 5b. What the third review round found

All four findings were in the fixes from §5, not in older code. Two of them
were in the *checks themselves*.

### 5b.1 The contrast gate gave a false pass

`--faint` was raised from 4.32 to 5.31:1 and the gate went green. But
`check-contrast.mjs` measured against `--bg` only, and `--faint` is used
*inside panels* — on `--surface-soft`, where the real ratio was **4.44:1**,
still failing.

| | on `--bg` | on `--surface-solid` | on `--surface-soft` |
| --- | --- | --- | --- |
| old `#7d8494` | 5.31 | 4.82 | **4.44** |
| now `#7f8696` | 5.45 | 4.95 | 4.56 |

So the round that made a contrast measurement into a gate shipped a contrast
failure through that gate, for precisely the reason it had just written down as
rule 10. The gate now measures every surface text sits on, and says in its own
header that glass surfaces are not knowable from the stylesheet so
`--surface-soft` stands in as the conservative case.

### 5b.2 A diagnostic nobody could read

`fetchProducts` threw `Error("GET /v1/products returned object without an
items array")` with a comment calling it "loud and specific". It is neither:
`messageFor()` maps anything that is not an `ApiError` to the generic UNKNOWN
message, so `ErrorNotice` showed none of it. The text reached no one. It is
now logged as well as thrown.

### 5b.3 Half a fix, described as a whole one

The same function checked that `items` was an array and then **cast** the
elements. `{items: [1, 2, 3]}` would have passed. The contracts package
exports the `productView` schema, and zod is already in the client bundle
(`messages.ts` imports `ERROR_CODES` as a value), so the proper parse was free
and simply had not been done. Malformed rows are now dropped loudly rather
than thrown on — one bad row should not cost the whole pricing page.

### 5b.4 Filtering the plans grid could empty it silently

Filtering on `PLAN_COPY` keeps un-described products off `/pricing`, which is
right. It also means a catalogue whose keys stop matching renders an empty
grid with no explanation — the same failure as §3.1, arrived at from the other
direction. There is now an explicit empty state, proved by forcing the filter
to match nothing.

### 5b.5 Graceful failure is silent failure — now recorded

The error boundary was a real improvement and a real regression at the same
time. Before it, a crash produced a blank page and a user who complained —
which is how `/pricing` was eventually found to have been broken for eight
days. After it, the same crash produced a calm panel, a `console.error`, and
very likely no report at all.

This was first left undone as an owner's decision, then taken. Three choices
were made in the taking, and they are the reason it is safe to keep:

**Self-hosted, not a third-party collector.** `POST /v1/client-errors` writes
through the existing `trackEvent` into `analytics_events`, which already
carries the §11.1 contract — never the raw prompt, the email address or any
card data. Shipping user data to an outside service is a decision about this
product's users, and nothing here required making it.

**Unauthenticated, and unattributable.** A crash on the sign-in screen is the
one most worth hearing about, so requiring a session would lose it. The
browser sends no token — `apiFetch` would have attached one, so the reporter
uses bare `fetch`, which also depends on less code that may be part of what
just broke. `user_ref` is null. A crash groups by message and route, not by
who hit it, and a test asserts that a token sent anyway changes nothing.

**No URL ever leaves the browser.** Only a normalised path: `/song/:id`, never
`location.href`. The query string on this product carries drafts and edit
targets, and on the composer the prompt itself.

Rate limited at 30 per five minutes per IP, with the client capping at three
distinct reports per page load. Verified end to end rather than reasoned
about: a deliberate throw in `Library` produced one row — `{"route":
"/library", "component": "Library"}` — and a second page load produced exactly
one more, so the dedupe survives StrictMode's double mount.

Reviewing the route caught one more thing: it was written with
`.catch(() => undefined)` on the write, which is rule 3, broken in the commit
that cites rule 3. A failed write must not turn a crash report into a 500, but
it must not vanish either. It logs.

## 5c. The route sweep

Rule 1 says a page is not done until it has been opened. Every route had not
been. All 22 were, in one pass: no crashes, no control without an accessible
name, one `<h1>` wherever a page renders a heading.

Two things came out of it.

### 5c.1 `/checkout/complete` rendered nothing without an order id

```tsx
if (!orderId) return <ErrorNotice error={error} />;   // error is still null
```

`ErrorNotice` returns `null` when there is no error, so the page came back
completely blank — the §3.1 failure, on the return from payment, which is the
worst moment a product can show someone an empty screen. Reached by a redirect
that drops the parameter, a bookmark, or a reload of a stale tab. It now names
the problem and offers billing and the composer.

`/projects/:id` and `/checkout/simulate` also looked nearly empty in the sweep
and turned out to be correct: a "Not found" state with a retry, and the demo
notice. Checked rather than assumed.

### 5c.2 `/legal/tokushoho` is `/legal/company` — open question

`Tokushoho()` is `return <Company />`. That page carries the operator block
(name, representative, address, contact, phone) and a refunds section.

特定商取引法に基づく表記 also requires the **price**, any **additional fees**,
the **payment method**, the **payment timing** and the **delivery timing**.
Those exist in the product — on the 最終確認画面 in `Checkout` — but the 表記
page must itself be reachable before a purchase, and it does not carry them.

Not drafted here, for the reason item 10 gives: this is copy a qualified person
writes. Recorded so it is a known gap rather than an assumption that two URLs
pointing at one page was deliberate.

## 6. What this document does not claim

- That Suno is badly built. It is a far larger product and the three `<h1>`s
  cost them nothing commercially. The comparison is a measuring stick, not a
  verdict.
- That the audit in §3 is complete. It covers headings, accessible names, touch
  size, placeholder-only labels, alt text, contrast tokens and one crash. It
  does not cover keyboard traps, screen-reader order, or `prefers-reduced-motion`
  beyond the global rule.
- That any of this was found by looking. Every item in §3 came from a measured
  check. The blank pricing page had been looked *at* — it is near-black and
  looked like a page still loading.
