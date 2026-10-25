# iOS PR-A build and handoff

See [architecture/route audit](IOS_ARCHITECTURE_AUDIT.md) and
[planning PR #23](https://github.com/lth2015/yuha/pull/23). This is an anonymous
engineering preview, not an App Store release. Login and private-library tabs
are explicit placeholders for PR-B. There is no native purchase flow, paid
operation, Keychain session, native background player or completed deep link.

## Reproduce from a clean clone

Requirements: Node >=22.13, pnpm 11.1.2, macOS and Xcode >=26.0 (validated toolchain:
26.2). Capacitor core/CLI/iOS are pinned to **8.5.3**; SwiftPM pins the same
version and its resolved revision. Minimum deployment target is iOS 15,
iPhone portrait only. No CocoaPods, Apple credentials or signing team required
for the unsigned simulator build.

```sh
pnpm install --frozen-lockfile
pnpm --filter @yuha/contracts build
pnpm ios:sync --environment production
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer \
  xcodebuild -project apps/web/ios/App/App.xcodeproj -scheme App \
  -configuration Debug -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath build/ios CODE_SIGNING_ALLOWED=NO build
pnpm ios:open --environment production
```

`ios:sync` always builds fresh assets, then copies them and native configuration
into Xcode. `ios:open` only opens Xcode; run sync again after changing sources or
environment. Never run `cap add ios` on the committed project. `pnpm build`
continues to produce the normal Web `dist`; iOS uses **dist-ios** and never
loads a remote Web site through `server.url` or a broad `allowNavigation`.
Bundled assets, generated Capacitor config and local Xcode outputs are ignored.

If Xcode points to CommandLineTools, use the per-command `DEVELOPER_DIR` above;
no system-wide developer-directory change is needed. Complete Xcode first
launch (`xcodebuild -runFirstLaunch`) and install an iOS Simulator runtime from
Xcode Settings > Components if a destination is unavailable. Simulator launch
requires an installed runtime; a build alone does not prove launch.

Choose an installed iPhone in Xcode and Run. The bundle ID is provisionally
`studio.yuha.app`, version `0.1.0`, build `1`; it is not a claim to a registered
App ID. The app icon and launch mark derive from the existing YUHA brand asset;
release brand authorization and final artwork remain operator checks.

## Environments and data boundaries

Every command requires `--environment development|staging|production`.
`pnpm ios:config ...` validates and prints only the public build configuration.

```sh
# A trusted HTTPS API you control; these example domains do not host a service.
IOS_API_URL=https://dev.example.invalid pnpm ios:sync --environment development
IOS_API_URL=https://staging.example.invalid pnpm ios:sync --environment staging
# Explicit production selection; fixed approved public origin, anonymous GETs.
pnpm ios:sync --environment production
```

Development and staging have no fallback. HTTP, credentials, paths, query
strings, fragments, and production origins under a non-production selector are
rejected. Production is restricted to `https://yuha.studio`. These select the
public API endpoint, not backend payment mode; no production configuration is
edited. All profiles currently use the same provisional bundle ID and therefore
replace one another when installed; use separate confirmed App IDs before
concurrent operator testing/distribution. Do not mistake a development API for
a data-isolated backend without verifying its database and adapters.

Native builds disable Vite `.env` loading, remove Google Fonts links, do not
publish source maps, and use system fonts. Only public Vite build values belong
in any frontend environment. Do not place production keys, administrator tokens,
Apple private keys, Stripe secrets or operator identity in a build file.

The iOS preview mounts only its consumer route tree. The API wrapper allows
four anonymous GETs and refuses all writes; it never reads/persists a Web
bearer token. Native HTTP is Capacitor's built-in transport, scoped by that
wrapper, so existing production Web CORS stays unchanged. Do not enable
CapacitorCookies, Web authentication or credentialed native requests implicitly.
The Web fetch implementation and payment pages continue to operate normally.

## Native configuration and release gates

- ATS explicitly denies arbitrary loads. Development requires trusted HTTPS;
  there is no exception for a local HTTP API.
- Safe-area insets cover top/side/bottom chrome; tabs and language controls have
  44px targets. Content can scroll above the Home Indicator; navigation focuses
  the main landmark. Dark/reduced-transparency styles are native-only.
- The Associated Domains entitlement contains `applinks:yuha.studio`. No Apple
  Team ID or server AASA is fabricated/deployed. This is configuration only:
  validate domain ownership, provision the confirmed App ID and serve a narrow
  AASA for song/auth routes before enabling native link handling in PR-B/C.
  SceneDelegate forwards native lifecycle/link events to Capacitor, but no
  native callback session or route mapping is implemented yet.
- No background-audio modes, microphone, photo, contact or tracking permissions
  are requested. PR-C/E adds only capabilities supported by real features and
  completes App Privacy/manifest review.
- No StoreKit capability, product, subscription, receipt verifier or transaction
  grant is enabled. PR-D needs server-verified idempotency and Sandbox evidence
  before any operator decision about real charges.

## Validation record

The implementation PR records the executed test results. Required checks:

```sh
pnpm build
pnpm typecheck
TEST_DATABASE_URL='<isolated local MySQL test URL>' pnpm test
pnpm check:orphans
pnpm check:i18n
pnpm check:contrast
pnpm check:stewardship
pnpm check:limits
pnpm check:type
pnpm check:ui
pnpm ios:sync --environment production
# Then the unsigned xcodebuild command above.
```

The existing Linux CI retains Web/API/MySQL/UI checks. A separate macOS job
selects Xcode 26.2, syncs bundled assets and compiles an unsigned iPhone simulator
app. It has read-only repository access and needs no Apple or payment secrets.

PR-A tests observe the API wrapper, build CLI, and rendered consumer navigation:
checkout/admin/auth writes blocked before network; stored Web tokens ignored;
unsafe/missing API origins rejected; login/library/unknown routes never mount
Web checkout or OAuth. They are not native networking or device tests.

Pending evidence must remain explicit: actual Apple/Google login, Keychain,
private-library synchronization, Universal Links/AASA, native background audio,
Bluetooth/phone interruptions, Files/Share Sheet, StoreKit Sandbox, signing,
archive, TestFlight, real-device VoiceOver/Dynamic Type/keyboard/large text and
two iPhone sizes/iOS versions. No Apple Developer account changes or real
payments were performed. Roll back by reverting this PR; no database migration
or backend/payment rollback is required.
