# UI design direction (superseded)

> **This document no longer describes the product.** It is kept as the record
> of the LOOPSCENE-era design — a light petal palette and a 30-second
> instrumental product — both of which have been replaced. Do not implement
> from it.
>
> What is current, in `apps/web`:
>
> - A dark studio palette with a coloured light field behind glass surfaces
>   (`styles.css`, `components/LightField.tsx`).
> - The score: a description read as music, which is also every song's sleeve,
>   the recording screen and the song page's transport (`lib/score.ts`,
>   `components/Score.tsx`).
> - Full songs, 30 seconds to four minutes, sung or instrumental — not a fixed
>   30-second instrumental.
>
> The scope decisions that drove those changes are recorded in `CLAUDE.md`.

Design system for LOOPSCENE, revised after a competitive review of **Suno**
(<https://suno.com/home>, reviewed 2026-09-10 at 1440px and 390px).

This document was the implementation reference for `apps/web`. It sat **under**
`PROJECT_TASK.md` §5 and §13 of the design doc, which fixed the palette, the
spacing baseline and the accessibility bar.

---

## 1. What we measured on Suno

Facts read from the live page's computed styles, not impressions:

| Property | Suno | LOOPSCENE today |
| --- | --- | --- |
| Page background | `#101012` | `#101115` (spec-locked) |
| Body text | `#F7F4EF` — **warm** off-white | `#F5F6F8` — cool off-white (spec-locked) |
| Typeface | Neue Montreal (licensed geometric grotesque) | Noto Sans JP |
| Display heading | **72px / line-height 1.0 / weight 500 / tracking −0.0133em** | 48px / 1.35 / weight 700 / −0.01em |
| Primary button | Fully rounded pill, **40px** tall, 15px text, weight 500 | 10px radius, 44px tall, 15px text, weight 700 |
| Secondary chips | Pill, 36px tall, `rgba(255,255,255,0.05)` fill | 10px radius, 44px, solid `#22252D` |
| Radius scale | pill · 24 · 20 · 12 · 6 | 16 (cards) · 10 (controls) |
| Background | Warm gradient mesh + film grain | Flat `#101115` |
| Hero | A working prompt composer | A link to `/create` |

### The four things Suno does that actually matter

1. **The input is the hero.** The landing page's centrepiece is a real composer
   — placeholder, attachment and "Advanced" chips, a randomise die, and one
   gradient Create button. No "Get started" interstitial.
2. **Display type is confident, not heavy.** 72px at weight **500** with
   line-height **1.0** and negative tracking. Large and calm rather than bold
   and loud. Most products reach for 700; this reads as more considered.
3. **The primary action is the only saturated thing on screen.** One
   orange→pink gradient, used exactly once. Everything else is translucent
   white at 5% opacity.
4. **Mobile collapses rather than compresses.** At 390px the nav drops to a
   single action — no hamburger — the headline stays huge (~44px), and the
   composer's chips become icon-only while Create keeps its label.

A fifth is effective but **not ours to take** — see §2.1: tilted, floating track
cards flanking the headline. It solves a real problem (demonstrate the output
instead of describing it), and we need to solve that problem too, in our own
vocabulary.

---

## 2. The line between borrowing and copying

Two separate questions, and they need separate answers.

### 2.1 Visual: convention or signature?

The test applied to every item in this document:

> **Convention** — many products arrived at it independently because it solves a
> problem. Using it is participating in a shared vocabulary.
> **Signature** — a specific expression that makes *this* product recognisable.
> Taking it means looking like a clone, whether or not it is legally protected.

| Borrowed item | Verdict | Reasoning |
| --- | --- | --- |
| Display type at weight 500, tight leading, negative tracking | **Convention** | The prevailing contemporary style across Linear, Stripe, Vercel, Arc and many others. Suno is one instance of it, not its origin. |
| Pill buttons and chips | **Convention** | Universal. |
| Translucent white surfaces (`rgba(255,255,255,0.05)`) | **Convention** | The standard way to build hierarchy on a dark ground without inventing new greys. |
| A radius scale by role rather than one radius | **Convention** | Ordinary design-system practice. |
| One saturated element per screen | **Convention** | Basic visual hierarchy, taught rather than invented. |
| Input as the hero | **Convention** — and independently required of us | ChatGPT, Perplexity, Midjourney, v0 and others use it. More to the point, UI-01 already asks for it: preview without an account, sign in only at generation. We would arrive here with no competitor to look at. |
| Mobile collapsing to a single action | **Convention** | Functional response to a narrow viewport. |
| Ambient gradient mesh + grain | **Convention, but the palette is the signature** | The technique is everywhere. Suno's *warm* orange→magenta is theirs. Ours is cool violet/lime because our palette is spec-locked — see §3.4. |
| **Tilted floating cards flanking the headline** | **Signature — rejected** | The specific arrangement is distinctively Suno's. Reproducing it would make us read as a derivative, which is a product problem before it is a legal one. Replaced in §4.3. |
| Gradient on the primary action | **Convention, recoloured** | Gradient CTAs are ordinary. Suno's is orange→pink; ours is lime→violet from our own tokens. |

**Where we end up anyway.** Our palette is cool graphite with lime and violet;
theirs is warm orange and magenta. Our type is Japanese-first Noto Sans JP;
theirs is a Latin display face. Our input is four fixed scene templates; theirs
is an open chat box. Our output is one 30-second instrumental; theirs is two
full songs with vocals. We have no feed. Someone who knows Suno will not mistake
the result for it — and if at any point they would, that is the signal that a
borrowing went too far.

One thing I am not qualified to rule on: whether any specific visual arrangement
is legally protectable as trade dress. If that question ever becomes live — for
example if marketing wants a side-by-side comparison — it needs a lawyer, not
this document.

### 2.2 Model: what is out of scope for us regardless

Separate from aesthetics. Copying Suno's information architecture would put us
outside our own scope and, in two cases, outside our acceptance criteria.

| Suno pattern | Why not |
| --- | --- |
| Explore / feed / trending / follows / likes | §1.2 excludes a public community, rankings and remixing outright. UI-05 additionally forbids showing "popular" or "everyone's using this" without verified data. |
| Other users' tracks on the landing page | UI-01 requires samples to have a lawful-source record. Ours are synthesised in-house; we cannot show user output we have no rights to display. |
| Open-ended "Chat to make music" | Our input is deliberately constrained: scene + mood + energy, 300 code points, screened before any spend (SEC-07). An open chat box invites exactly the artist-name and lyric prompts we must reject. |
| Two songs per generation | §6.1 is explicit: one credit must not be implemented as several paid upstream results. We deliver **one** 30s track per credit and say so. |
| Lyrics, vocals, personas, covers | Out of scope at launch (§1.2), and the input screen actively blocks them. |
| 15px body text, low-contrast muted text over a gradient | UI-14 sets 16–18px body and a 4.5:1 contrast target. We do not trade that for density. |

**The honest summary:** we are borrowing Suno's *craft* — typography, restraint
with colour, the input-as-hero move, mobile collapse — and none of its *model*.

---

## 3. Revised design tokens

### 3.1 Unchanged (spec-locked by `PROJECT_TASK.md` §5)

```
--bg          #101115      --text        #F5F6F8
--panel       #1A1C22      --text-muted  #A9AFBE
--accent      #D4FF62      --accent-soft #B6A0FF
```

Card radius stays 16px. Spacing stays on an 8px baseline. Touch targets stay
≥44px. Body text stays 16–18px. These are not up for redesign here.

Note the tension worth flagging: Suno's warm `#F7F4EF` reads better against a
warm gradient than our cool `#F5F6F8` does. Our palette is cool and specified,
so we keep it — but it means our ambient gradient should stay **cool**
(violet/lime), not warm (orange/magenta). Copying Suno's warm mesh under our
cool text would look wrong.

### 3.2 Changed

```css
/* Radius: one value per role, rather than one value everywhere. */
--radius-pill:  9999px;  /* buttons, chips, badges        */
--radius-lg:    24px;    /* hero composer, modals         */
--radius:       16px;    /* cards                (locked) */
--radius-sm:    12px;    /* inputs, table wrappers        */

/* Control heights: 44px stays the minimum for anything tappable. */
--control-h:      44px;  /* primary and secondary buttons */
--control-h-chip: 44px;  /* chips — Suno's 36px fails UI-14 */

/* Translucent surfaces, replacing solid --panel-raised for controls. */
--surface-1: rgba(255, 255, 255, 0.05);
--surface-2: rgba(255, 255, 255, 0.08);
--hairline:  rgba(255, 255, 255, 0.10);
```

### 3.3 Type scale

The single biggest visual change. Display type moves to weight 500 with a tight
line-height and negative tracking.

| Role | Size | Weight | Line-height | Tracking |
| --- | --- | --- | --- | --- |
| Display (landing hero) | `clamp(40px, 7vw, 72px)` | **500** | **1.05** | −0.02em |
| H1 (page title) | `clamp(26px, 4vw, 38px)` | 500 | 1.2 | −0.015em |
| H2 | 20–24px | 600 | 1.3 | −0.01em |
| Body | 16px (17px on wide) | 400 | **1.8** | 0 |
| Small / meta | 13px | 400 | 1.6 | 0 |
| Numeric | 16px | 500 | 1.4 | 0, tabular |

**Japanese-specific caveat.** Suno's −0.0133em tracking works because Neue
Montreal is a Latin display face. Japanese glyphs are already full-width and
negative tracking makes kana and kanji collide. So:

```css
/* Negative tracking applies to Latin only; Japanese text keeps normal spacing. */
.display { letter-spacing: -0.02em; }
.display:lang(ja) { letter-spacing: normal; }
```

Line-height 1.05 is also too tight for mixed Japanese — kanji need vertical
room. Use **1.25** on any display line that contains Japanese, which in practice
is all of ours. The tight-leading look has to be achieved through size and
weight instead.

Body line-height goes **up**, not down: 1.8 for Japanese (currently 1.7). Dense
kanji needs more leading than Latin, not less.

### 3.4 Ambient background

Replace the flat `#101115` with a subtle cool mesh over the same base, plus
grain. This is the cheapest change with the largest perceived-quality return.

```css
body {
  background:
    radial-gradient(60% 50% at 15% 0%,  rgba(182,160,255,0.10), transparent 60%),
    radial-gradient(50% 40% at 90% 10%, rgba(212,255,98,0.06),  transparent 60%),
    var(--bg);
  background-attachment: fixed;
}
```

Grain goes on a `::before` overlay at ~3% opacity using an inline SVG
`feTurbulence`, `pointer-events: none`. Keep it under 4% — above that it fights
Japanese text legibility at 16px.

Constraint: the mesh must stay behind panels. `--panel` stays a solid `#1A1C22`
so text always sits on a known background and contrast stays measurable.

---

## 4. Component revisions

### 4.1 Buttons

```
Primary    pill · 44px · 15px/600 · --accent on #10130A · no gradient by default
Secondary  pill · 44px · 15px/500 · --surface-1 · 1px --hairline border
Ghost      pill · 44px · 15px/500 · transparent · --hairline border
Chip       pill · 44px · 14px/500 · --surface-1, --surface-2 when pressed
```

On the **gradient**: Suno uses one. We may use one — on the single primary
action of the landing page only (`サウンドをつくる`), as
`linear-gradient(100deg, #D4FF62, #B6A0FF)`. Everywhere else the primary button
is flat `--accent`. A gradient that appears on every button stops signalling
anything.

Retain the existing focus ring (3px `--accent-soft`, 2px offset) unchanged — it
is an accessibility requirement, not a style choice.

### 4.2 The composer becomes the hero (UI-01 + UI-03)

The largest structural change, and the one that fits our spec best.

Today `/` shows a headline and a link to `/create`. Instead, `/` hosts a **real,
working composer**: scene chips, the mood textarea, the energy slider, and one
primary action.

This is not merely cosmetic — it is what UI-01 already asks for:

> 访客可先试听，开始生成时再登录 · 场景选择继承到创建页，不要求用户重复填写

A visitor composes without an account. On submit:

- **signed in with credits** → the job starts;
- **signed in, no credits** → `/pricing`, draft preserved;
- **signed out** → `/auth?next=/create`, draft preserved in `localStorage` and
  rehydrated after sign-in.

The draft-preservation machinery already exists in `Create.tsx`; this lifts the
form to `/` and reuses it.

```
┌─────────────────────────────────────────────┐
│  シーンを選ぶ。気分を書く。                   │  display, 500, 1.25
│  30秒のBGMができる。                          │
│                                             │
│  ┌───────────────────────────────────────┐  │  --radius-lg, --surface-1
│  │ [夜の散歩] [日常記録] [コーデ] [ゲーム]  │  │  chips, pill, 44px
│  │                                       │  │
│  │  どんな気分にしたいですか？             │  │  textarea, no border
│  │                                       │  │
│  │  ⚡──────●────────        [つくる →]   │  │  energy + primary
│  └───────────────────────────────────────┘  │
│  1回消費 · 残り4回 · 30秒 · 歌詞なし          │  meta line, 13px
└─────────────────────────────────────────────┘
```

The meta line under the composer carries what UI-03 requires before submission:
cost of this run, real remaining balance, fixed duration, instrumental-only.
Suno hides its credit cost behind an icon; we do not.

### 4.3 Sample cards — the 30-second ruler

The problem Suno solves with tilted flanking cards is real: **show the output,
do not describe it.** We need to solve it. We should not solve it their way
(§2.1).

Our own answer comes from the constraint that defines this product and does not
exist in Suno's: **every track is exactly 30 seconds.** So the recurring motif
is a 0–30s ruler.

```
夜の散歩 / 静けさ
┌────────────────────────────────────────────┐
│ ▶   │────────────────╎───────────────────│ │
└────────────────────────────────────────────┘
      0s              15s                 30s
                       ↑
              the 15s export point, marked
```

A thin baseline with tick marks at 0 / 15 / 30, the played portion filled in
`--accent`, and the 15s point marked because that is the *other* export length a
user can choose. The same motif carries across three places:

- **sample cards** on the landing page — flat, in-grid, no tilt;
- **the player scrubber** — the ruler is the scrubber;
- **the export trimmer** — the 15s window is a bracket that slides along the
  same ruler.

That earns its place three times instead of decorating once, it teaches the
15s/30s choice before the user reaches the export screen, and it is meaningless
to a product without a fixed duration — which is exactly what makes it ours.

Important: the ruler shows **time**, never amplitude. We have no peak data, and
drawing a waveform-shaped bar would be a fabricated picture of audio nobody has
analysed. Ticks and a fill, nothing more.

Two rules regardless of treatment:

- `prefers-reduced-motion` removes the fill animation;
- the provenance note (`GET /v1/samples` → `provenance`) stays visible beside
  the samples. UI-01 requires a lawful-source record, and a nicer visual does
  not earn the right to bury it.

### 4.4 Generation progress (UI-04)

Keep the current five-stage indicator. Two refinements:

- the active stage's shimmer becomes a slower, lower-contrast sweep (1.6s →
  2.4s, `--accent-soft` at 40%) — the current one reads as urgency, and this is
  a 30–120 second wait;
- the stage label gets the display treatment at H1 size so the waiting screen
  feels intentional rather than like a stalled form.

What does **not** change: no percentage, ever. UI-04 forbids a fabricated
precise figure, and the honest time range stays.

### 4.5 Player

The current single-shared-audio player is correct and stays. Visual changes
only: pill transport button at 44px, the §4.3 ruler as the scrubber, and
tabular-numeric time.

### 4.6 Mobile (≤767px)

Follow Suno's collapse, not a hamburger:

- header keeps brand + balance badge + one action;
- secondary navigation moves to a bottom tab bar (つくる / 作品 / 請求) inside
  `env(safe-area-inset-bottom)`;
- the composer's scene chips scroll horizontally in their own strip rather than
  wrapping — the same pattern already applied to the header nav;
- display type stays large: `clamp(40px, 7vw, …)` means 390px still gets ~27px
  rather than dropping to a timid 22px.

---

## 5. Accessibility is not part of the trade

Suno ships 15px body text, 36px chips and low-contrast muted text over a busy
gradient. We are matching its *look*, not its contrast ratios.

| Requirement (UI-14) | Rule |
| --- | --- |
| Touch targets | ≥44px. Chips stay 44px even though Suno's are 36px. |
| Body contrast | 4.5:1. **Currently unmeasured — see below.** |
| Focus | Visible ring, never removed. |
| Motion | Tilt, shimmer and gradients all respect `prefers-reduced-motion`. |
| Autoplay | Never. Playback starts only from a user gesture. |

**Open and blocking:** `--text-muted #A9AFBE` on `--panel #1A1C22` has not been
measured against 4.5:1. It must be checked before this redesign ships, and if it
fails, `--text-muted` gets lighter — the token moves, the rule does not. Tracked
in `docs/OPEN_ITEMS.md` §3.

Adding the ambient mesh makes this more urgent, not less: any text that sits on
the mesh rather than on a panel needs re-measuring against the *lightest* point
of the gradient, not the base colour.

---

## 6. Typography licensing

Suno uses Neue Montreal, which is commercially licensed. We do not have it and
must not use it.

Our stack stays **Noto Sans JP** (SIL Open Font License — redistributable, and
already recorded in the dependency inventory §24 requires). It is a humanist
sans and will not look like Neue Montreal at weight 500, and that is acceptable:
the confident-display effect comes mostly from *size, weight restraint and
leading*, not from the specific face.

If a distinctive Latin display face is wanted later for the wordmark and the
landing headline only, it needs a licence review before use — including whether
the licence covers webfont serving. Until then the wordmark stays Noto Sans JP
with wide tracking, which is what ships today.

---

## 7. Implementation order

Roughly ascending risk. Each step is independently shippable.

| # | Change | Files | Risk |
| --- | --- | --- | --- |
| 1 | Radius scale, translucent surfaces, pill buttons | `styles.css` | Low |
| 2 | Type scale + the `:lang(ja)` tracking rule | `styles.css` | Low |
| 3 | Ambient mesh + grain | `styles.css` | Low |
| 4 | **Measure contrast**, adjust `--text-muted` if it fails | `styles.css` | Low, blocking |
| 5 | Progress and player refinements | `common.tsx` | Low |
| 6 | Mobile bottom tab bar | `Layout.tsx` | Medium |
| 7 | 30s ruler motif (samples, scrubber, trimmer) | `common.tsx`, `Home.tsx`, `Export.tsx` | Medium |
| 8 | **Composer on the landing page** | `Home.tsx`, `Create.tsx` | **High** |

Step 8 is the valuable one and the one that can break things: it moves the
generation entry point, so the draft-preservation, sign-in redirect and
idempotency-key lifecycle all need re-testing. The existing browser walkthrough
in `docs/ACCEPTANCE.md` (UI-01, UI-03) must be re-run afterwards, and the
`tests/generation.test.ts` idempotency cases still have to pass unchanged.

---

## 8. What this does not claim

This is a craft judgement, not a validated one. Suno is a much larger product
with a different licence position, a different scope and a different audience;
that its landing page converts for them is not evidence it will for us, and
§11.3 is explicit that design changes are not validated by taste.

If the redesign is meant to be tested rather than simply preferred, §10 requires
one variable at a time with the funnel definitions already implemented in
`packages/db/src/reporting.ts`. The metric that would matter here is
**activation** (register → generate → preview ≥10s → export within 24h), which
currently reports "not computable" because the client does not yet emit the
`preview_10s` event — see `docs/OPEN_ITEMS.md` §3.

Fix that event first if this is going to be measured rather than asserted.
