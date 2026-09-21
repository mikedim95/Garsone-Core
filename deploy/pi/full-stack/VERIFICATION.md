# Pre-deployment verification — 2026-09-21

Prepared for a 64-bit Raspberry Pi, without connecting to the remote Pi.

## Passed

- Git fetch: Core, Front and Nodes were on `main` and matched origin before
  changes. Their existing ARM64 publishing workflows were inspected. Latest
  public Core and Front runs both succeeded at the recorded original commits.
- Built ARM64 Core, Front and optional Nodes images locally with Docker.
- Started ARM64 PostgreSQL, Core and Front under the isolated
  `garsone-prework-test` Compose project. These three became healthy. No MQTT
  broker or node-agent container was needed.
- Exported current Noor production data using a read-only repeatable-read
  transaction: 54 items, 5 categories, 12 modifiers/34 options, 11 tables,
  5 profiles, 9 QR tiles, 10 orders and their related rows.
- Downloaded 59 venue images and rewrote their catalogue URLs to local uploads.
- Imported the snapshot into a fresh local PostgreSQL volume. Existing staff
  hashes are copied unchanged. Created a separate local architect; repeating
  that action refused to replace the existing account/password.
- Browser smoke: local login, 54 menu items, image retrieval, Noor QR resolution,
  WebSocket connection through `/api`, and local order creation. External
  browser requests were intercepted; none were attempted on these tested pages.
  This development check uses `playwright-core` (or `PLAYWRIGHT_MODULE` pointing
  to an installed copy) and `CHROME_PATH`; browser test tooling is not required
  on the Pi.
- Local Viva checkout endpoint rejects online checkout with HTTP 503.
- Linux PTY test: direct serial ESC/POS output, Greek CP1253 encoding, item
  filtering, consecutive ticket ordering, and control-byte sanitization.
- Compose configuration, Bash syntax, Core TypeScript build and Node Python
  syntax validation. The existing Core publishing workflow now runs the PTY
  test before publishing.
- Retrieved Noor's saved two-printer metadata separately. Both are configured
  as 58 mm printers using CP1253/codepage 7. Prepared their individual host
  binding files in the private data bundle.
- Render's external database allowlist was restored to `[]` and verified after
  each temporary, laptop-only export window. Hosted rows were not changed.

## Event QR and security update

- Core and Front compile with Node 24, Fastify 5 and updated browser dependencies.
- Rebuilt ARM64 Core and Front images (`20260921-qr-security`) start with
  PostgreSQL as the only three default services. Browser login, Noor menu/images,
  WebSocket proxy, event QR creation/redirect, anonymous local ordering and event
  deactivation pass with no cloud browser requests on the tested pages.
- The Node 24 Linux printer simulation passes direct serial/Greek output and
  uncertain-job preservation after a missing device/restart.
- 17 isolated HTTP/realtime/upload/push/sync regression checks pass, including
  tenant isolation, scoped tokens, HTTPS-only sync and failed-update preservation.
- QR event API integration: 7 subtests and their parent suite pass against a
  dedicated local PostgreSQL database. No production rows are used or changed.
- Architect browser verification: 10 checks pass, including event issuance,
  edited destinations, table assignment, safe printing, import/export, pairing
  downloads, stale edits and no requests to the configured LAN destination.
- Front dependency audit reports zero advisories; Core retains three high
  Prisma CLI configuration advisories. See [the security review](../../../SECURITY-REVIEW.md)
  for remaining payment, LAN transport, credential and session risks.
- Event configuration does not change network/DNS/listening ports; the event
  App/API URLs must match the Pi configuration documented in [EVENT_QR.md](EVENT_QR.md).

## UX update

- Event setup now validates and focuses invalid fields, derives the default API
  address, protects drafts with confirmation dialogs, and distinguishes local
  saves from cloud revisions waiting for transfer or sync. Sticky actions,
  assignment search/status counts and undo make large events easier to manage.
- Printing checks the latest saved revision and active tables. Exports use the
  actual downloaded revision; replacing a pairing token resets its old applied
  status. No dashboard requests go to configured LAN destinations.
- Customer QR scans have visible loading, retry and unavailable states in Greek
  and English. Printed resolver error pages are self-contained and use no cloud
  assets. Successful event resolution honors the configured customer app.
- Checkout prevents overlapping submissions, freezes the cart while sending,
  preserves notes across category navigation and keeps drafts after failures.
  Modifier minimum/maximum selections, item availability and quantity bounds
  are checked before ordering. Local orders do not wait for push registration.
- Staff login has labelled controls, password visibility, a bounded sign-in wait
  and password-change rules matching Core (12–72 characters).
- The app respects reduced-motion preferences. Mobile scan, checkout and event
  editor screenshots were inspected.
- Core build and 24 isolated regression checks pass. Front app/node TypeScript
  checks, targeted ESLint, production build and 3 order-validation checks pass.
  Browser suites cover 16 event workflow checks, 8 mobile QR scenarios, and
  guest menu failure/retry, modifier limits, note preservation, frozen checkout
  and duplicate prevention. API data in these suites is synthetic.
- Publishing workflows now run the real Front app/node type checks and order
  validation tests, and Core's public QR response checks before image builds.
- Final ARM64 images are tagged `20260921-ux`. PostgreSQL, Core and Front pass
  their health checks; the real Noor stack also passes local event dashboard
  readiness, login/menu/image/WebSocket, QR and guest-order checks. Local-mode
  guest browser regression checks also pass against the container frontend.
  The original private Noor data archive checksum remains unchanged.

## Mobile visual update

- Menu categories use one mounted pane with short, bounded transitions; active
  dots/dashes, previous/next controls, keyboard navigation and translated swipe
  hints make category navigation discoverable. Vertical scrolling preserves the
  current category and cart contents. Reduced-motion preferences are respected.
- Headers stay pinned after scrolling. Phone typography and safe-area spacing
  are stable, while short landscape screens use compact horizontal item cards.
  Cart and order sheets scroll independently; only their handles start dismissal.
  Long Greek item names wrap, and cart/modifier actions remain within the viewport.
  Customer dialogs retain the selected color theme in dark mode.
- Login fields remain 16 px at every tested breakpoint, password controls have
  44 px targets, and phone sign-in fits the initial portrait viewport. The
  Architect uses compact horizontal navigation, stacked assignment cards,
  contextual setup help and save/print actions below the measured sticky header.
- Browser checks cover 320x568, 390x844, 844x390 and 1440x900 in English and Greek,
  plus dark mode and reduced motion. They sample geometry during transitions,
  exercise touch/keyboard navigation, inspect long-content dialogs, and verify
  focus return. Screenshots and JSON reports are in the ignored
  `artifacts/mobile-polish` directory; repeatable tests are in `Garsone-Front/tests`.
- These checks use Chrome emulation and synthetic API fixtures. Actual mobile
  browser bars, virtual keyboards and display cutouts still need device testing.
- Final runtime images are `garsone/front:20260921-mobile`,
  `garsone/core:20260921-ux` and `postgres:16-alpine`, all Linux ARM64. All three
  services pass health checks. The isolated Noor stack passes login, 54 items,
  local images, WebSocket proxy, event issuance/redirect/deactivation and local
  ordering without cloud requests. The original Noor data archive is unchanged.
- Front app/node type checks, targeted ESLint, unit checks and production builds
  pass. Browser regressions pass for 17 Architect checks, 8 QR scan cases, and
  local checkout retry, frozen submission, duplicate prevention and notes.

## Remaining physical checks

- Confirm Pi OS is ARM64, its stable LAN address/DNS, available storage,
  installed Docker/Compose, and its existing containers/volumes.
- Pair/trust the actual printers; verify saved MACs, SPP channel, device groups,
  Greek characters, width, feed/cut, disconnection recovery and reboot startup.
  A simulated serial device cannot prove Bluetooth radio or paper output.
- Print QR codes containing the Pi's local address and check phones on the
  venue Wi-Fi with WAN disconnected. Old cloud-domain stickers stay external.
- Take a final Noor snapshot at cutover if production data has changed since
  this export. No automatic post-export synchronization is configured.

These checks were performed locally before Git publication. No Pi or Render
application deployment was used for verification. The prebuilt archive can be
used independently of publication; pushes to `main` use the existing GitHub
container workflows. Check those workflow runs for publication status.
The Pi runtime and prebuilt image archive contain only PostgreSQL, Core and
Front. QR Studio is development only and is excluded from onsite services,
configuration and source/image bundles.

Relevant original workflow runs:
[Core](https://github.com/mikedim95/Garsone-Core/actions/runs/30165649762),
[Front](https://github.com/mikedim95/Garsone-Front/actions/runs/30165650657).
