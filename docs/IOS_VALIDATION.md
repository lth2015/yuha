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

The computer-use tool timed out opening the Simulator window, including a
bounded retry by its full application path. No native screenshot, tab tapping,
keyboard, dark-mode, large-text or VoiceOver result is claimed. Browser preview
and a running native process do not substitute for those tests. Reproduce the
unsigned build, open Simulator locally and check Home → Library → Login before
considering the visual part of PR-A acceptance closed.

Real-device tests, Apple/Google OAuth, Keychain, private-library synchronization,
AASA/Universal Links, AVAudioSession/lock-screen/Bluetooth/interruption handling,
Files/Share Sheet, StoreKit Sandbox, signed archive, TestFlight and App Store
review remain pending their planned phases. No Apple account, production
payment setting, real transaction, server ledger or database schema was changed.

Rollback is a revert of the implementation PR; existing backend and Web payment
configuration require no migration or operational rollback.
