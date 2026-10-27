# PR-A validation and review record

2026-10-25; base `b4cfee4163d97650c988cfc48ca73ecef36a3d98`.
Scope: IOS-YUHA-01/02 in planning PR #23. This is a development scaffold;
PR-B authentication/library, PR-C native audio and PR-D StoreKit are not enabled.

## Executed checks

- `pnpm build`, `pnpm typecheck`, `pnpm ios:sync --environment production`: passed.
- MySQL-backed full suite and focused iOS/API tests were executed locally; final
  counts and CI results are recorded in the implementation PR.
- `check:orphans`, `check:i18n`, `check:contrast`, `check:stewardship`,
  `check:limits`, `check:type`: passed. Stewardship includes the staged new
  native files; this scan does not establish legal approval.
- Xcode 26.2 (17C52), SwiftPM Capacitor 8.5.3, Debug unsigned iPhone simulator
  build: `BUILD SUCCEEDED` using the command in IOS_DEVELOPMENT.md.
- Installed that App on iPhone 17 Pro, iOS 26.3.1 (23D8133), and launched
  `studio.yuha.app` successfully. The application remained in the simulator's
  launch service with a running PID. This is process-start evidence, not a
  native screen, authentication or playback acceptance claim.
- Browser preview at 393 × 852: Japanese homepage, login placeholder and
  private-library placeholder navigation checked; no checkout/auth form mounted.
  DOM integration tests also cover library navigation and blocked checkout paths.
  The browser viewport override was reset after acceptance.

## Standards

One P2 found and fixed: using a lazy root App to select iOS added a Web chunk
failure path outside the existing ErrorBoundary. `main.tsx` now statically
imports a Vite build-time alias; Web retains the direct root import behavior.
Final independent standards re-review found no remaining code blocker or smell.

## Spec

One minor omission found and fixed with a failing-then-passing public API test:
the shared statutory disclosure could not read `/v1/products`. It now has
anonymous read access; checkout and all writes remain blocked before networking.
The audit and build guide reflect the four GET endpoints. Final independent
spec re-review found no remaining code/document issue; native screen evidence
and later-phase features remain explicitly unverified.

Two-axis summary: Standards 1 P2 closed, remaining 0; Spec 1 minor issue closed,
remaining 0 code/document issues. Native interaction evidence is still partial.

## Unverified and handoff

The original Simulator window launch issue was bypassed using Capacitor's
supported `cap run ios --target <device-id> --no-sync` after building assets.
Actual native inspection found two defects invisible in browser preview:
CJK text (including default-font buttons) rendered as missing glyphs on the
installed iOS 26.3.1 runtime, and dark-mode logo inversion made the wordmark
dark while turning the orange petal blue. Both were reproduced before repair.

The native entry now imports pinned, locally bundled Noto Sans SC/JP variable
fonts, including full OFL notices in the copied app resources, and native form
controls inherit the same family. The same simulator now renders Chinese
headings, body, labels, placeholders and mood buttons. No online font request
is required; Web output contains no added WOFF2 assets. Native web resources
are approximately 11 MiB including both font families; the Web output remains
approximately 2.9 MiB. System-font-only substitution did not resolve the
observed failure and was not retained. The precise underlying runtime/font
service fault is not claimed as established.

Dark mode keeps the logo's `currentColor` wordmark and original orange petal,
reduces the bright glass overlay, and uses readable placeholders and semantic
text colors. Native typography now uses WebKit's system body text size with
relative type tokens; header wrapping and scaled bottom clearance accommodate
larger text. A larger preferred system text size was exercised on the iPhone
17 Pro; this does not certify every accessibility size or every page.

A separate fresh iPhone 16e simulator instance was installed and launched with
Japanese app-language arguments. Its Japanese headings, body, placeholders,
mood labels and bottom navigation rendered correctly in light mode. Both
simulators used iOS 26.3.1; these are not two real devices or two OS versions.

Some later coordinate/keyboard actions failed in the computer-use tool even
though AX menu actions and native screenshots remained available. Keyboard,
VoiceOver, all accessibility sizes and complete native route interaction remain
pending where not explicitly exercised. No browser image is represented as a
native screenshot.

Real-device tests, Apple/Google OAuth, Keychain, private-library synchronization,
AASA/Universal Links, AVAudioSession/lock-screen/Bluetooth/interruption handling,
Files/Share Sheet, StoreKit Sandbox, signed archive, TestFlight and App Store
review remain pending their planned phases. No Apple account, production
payment setting, real transaction, server ledger or database schema was changed.

Rollback is a revert of the implementation PR; existing backend and Web payment
configuration require no migration or operational rollback.

## 2026-10-27 release freeze pass (封版)

The product owner froze the project for release on 2026-10-27. The iOS app
stays at PR-A, the anonymous preview above; this pass checks that the day's
Web changes reached it correctly and break none of its boundaries. It was run
in Chromium against `dist-ios` from `pnpm ios:build --environment production`,
with the app's `https://yuha.studio` requests answered by a local demo API.
It is browser evidence, not a native screenshot or device test.

- 360, 390 and 430 px with touch, in zh, ja and en: no element wider than the
  screen outside a horizontal scroller, no page errors.
- What changed on the Web that day, as the preview shows it: style tags in the
  reader's language (鼓打贝斯 / ドラムンベース / drum & bass); the showcase's
  arrows hidden on a touch screen (`hover: none`, computed `display: none`),
  the fade and the swipe remaining; the Air composition entry absent, as the
  preview ships no `/air`.
- Tap targets: the header logo and the footer's legal link were 32 and 22 px
  tall, under the 44 pt the rest of the preview keeps. Fixed in `ios.css`;
  every link and button on Home now measures at least 44 px.
- Signed out, pressing generate goes to the sign-in placeholder; the library,
  sign-in and legal routes render. Requests made across all of that: GET
  `/v1/runtime`, `/v1/explore`, `/v1/products`, `/v1/legal/business-disclosure`
  only, and no write.
- The macOS CI job (unsigned simulator build) passed on every PR merged that
  day (#50–#53).

Still pending, unchanged: everything listed under "Unverified and handoff".
