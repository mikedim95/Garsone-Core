# Application security review — 2026-09-21

This review covered the Core API, Front browser application, QR issuance and
resolution, event traffic, node configuration delivery, uploads, push delivery,
authentication, and dependency inventories. The changes are local workspace
changes; production services and the remote Pi have not been updated. This is a
code review with focused regression tests, not a claim of a complete penetration
test or evidence that an intrusion occurred.

## Findings fixed in this workspace

| Priority | Previous behavior and impact | Change and source |
| --- | --- | --- |
| Critical | Anonymous WebSocket connections could receive node configuration, including node/config tokens and Wi-Fi/MQTT credentials, when an architect claimed, configured, or rotated a node. Node messages passed through the same unrestricted broadcast as browser events. | Browser realtime rejects node control topics entirely, isolates every staff session by its authenticated venue, checks current account/store/role at connection, and bounds message/backpressure size. [Realtime](src/lib/realtime.ts), [node publication source](src/routes/nodeAgents.ts). |
| High | Managers could use another venue's resource UUID to change/delete menu records or QR tiles and could list/change other venue settings. | A manager resource/foreign-key authorization guard runs before mutation; QR store/tile guards and filtered store lists enforce ownership. Architects retain their intended cross-venue authority. [Manager guard](src/middleware/managerScope.ts), [QR routes](src/routes/qrTiles.ts). |
| High | Any caller could read recent orders through `/orders-benchmark`, submit cloud Noor orders without approval, or bypass approval in any venue by providing an invented `paymentSessionId`. | Benchmark now requires a manager/architect session. Cloud guest creation/editing requires QR locality approval; an explicit `LOCAL_ONLY=true` exception applies only to the Pi's configured `STORE_SLUG`. Order size/quantity are bounded. [Orders](src/routes/orders.ts). |
| High | Browser event publication accepted arbitrary topics/payloads from staff, allowing forged order/node events; anonymous events contained full order details across venues/tables. | Clients may publish only their own venue's harmless `client/refresh`; actual order/node messages originate from domain routes. Anonymous realtime requires an active table/venue scope and forwards only that table's status identifiers. [Events](src/routes/events.ts), [realtime](src/lib/realtime.ts). |
| High | Uploaded SVG/HTML or misleading file extensions could execute active content when opened on the application origin, potentially exposing browser sessions. Upload serving also lacked Windows backslash/symlink containment. | New uploads accept PNG/JPEG/GIF/WebP signatures with MIME/extension derived from bytes. Existing media responses are sandboxed with CSP and `nosniff`; local paths are checked against the real upload root. Local image URLs use `/uploads/...`, independent of request Host. [Image validation](src/lib/imageUpload.ts), [upload routes](src/routes/manager.ts). |
| High | Public push subscriptions accepted arbitrary client URLs, later used for server-side requests on order updates; persisted malicious URLs could remain active. | HTTPS/443 destinations are restricted to known browser push services and optional operator-configured exact trusted hosts. Validation runs at registration and delivery. Local installations disable cloud push even if VAPID keys exist. Delivery has a timeout. [Endpoint validation](src/lib/pushEndpoint.ts), [customer push](src/lib/customerPush.ts), [staff push](src/lib/staffPush.ts). |
| High | Missing JWT configuration fell back to a known signing secret; query tokens were accepted on CRUD requests and printed in request logs; development login could be enabled in production. | Strong configured signing secrets and HS256/claim checks are required. Authenticated requests re-check current account/store/role. CRUD query tokens are rejected, sensitive logging is reduced, and development login is disabled in production/local installations. [JWT](src/lib/jwt.ts), [auth middleware](src/middleware/auth.ts), [login](src/routes/auth.ts), [server](src/server.ts). |
| Medium | All browser origins were reflected with credentials; unlimited sign-in attempts and trusted forwarded headers weakened the boundary. Production QR redirects could depend on attacker-controlled Host. | Explicit origin enforcement applies to HTTP and WebSocket; authentication/API requests are rate-limited; proxy trust is configured; production QR redirects use configured/event destinations. QR codes now use cryptographic randomness. [HTTP security](src/lib/httpSecurity.ts), [server](src/server.ts), [QR routes](src/routes/qrTiles.ts). |
| Medium | Public reads or sign-in attempts with invented store slugs implicitly created database tenants. | A missing venue lookup fails. Creation remains an architect provisioning operation. [Store lookup](src/lib/store.ts). |

Push endpoint allowlisting follows browser push infrastructure rather than
arbitrary customer URLs. See [Google's push server example](https://web.dev/articles/codelab-notifications-push-server)
and [Microsoft's channel-domain validation guidance](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/push-notifications/wns-overview).
`PUSH_ALLOWED_HOSTS` is for exact hostnames of trusted additional push providers,
not user-controlled webhooks. It does not permit HTTP, private IP literals, or
local hostnames.

## Remaining deployment and product risks

- **Hosted rollout configuration:** use Node 24, a random `JWT_SECRET` of at
  least 32 bytes, and explicit frontend origins in `CORS_ORIGINS` where the
  standard `https://garsone.gr` venue domains are not used. Set
  `TRUST_PROXY_HOPS` only to the verified proxy depth; the Pi bundle uses its
  single nginx proxy. Missing/weak JWT secrets now stop startup.
- **Rotate previously broadcast credentials at cutover.** Node tokens, MQTT
  credentials, and Wi-Fi passwords may have been delivered to connected clients
  by the old realtime code. The review does not establish that anyone captured
  them. Deploy the fix before issuing replacement credentials. Existing cloud
  deployments remain exposed until they are updated.
- **HTTP on a shared LAN does not protect staff credentials or tokens in
  transit.** Use a controlled venue network and HTTPS with a hostname/certificate
  trusted by customer devices where confidential access is needed. Keep database
  and Core administration ports private. The cloud architect must use HTTPS.
- **A printed QR is a bearer location link, not proof of physical presence or
  customer identity.** A photograph or copied URL can be reused. Public table
  IDs and table-order views remain available by design; guests who know the
  table can view that table's order history, and the local mode intentionally
  allows table ordering/editing without cloud approval. For hostile-attendee
  events, add per-visit/customer capabilities and enforce ownership across all
  public read/edit/call-waiter routes before treating orders as private.
- **The legacy IP whitelist is inactive.** `ALLOW_ALL=true` in
  [ipWhitelist.ts](src/middleware/ipWhitelist.ts) means setting `ALLOWED_IPS`
  currently has no effect. Do not use it as evidence of LAN-only access; enforce
  reachability at the network/proxy boundary. QR approval proves code knowledge,
  not a network or geographical position.
- **Historical passwords and issued tokens need operational attention.** Noor's
  imported password hashes were preserved. Replace known/demo/shared passwords
  and use unique staff credentials. Existing staff-creation routes still accept
  passwords as short as four characters in the architect UI or six in manager
  routes; a stronger uniform password policy remains an improvement. Password changes currently do not revoke
  every previously issued JWT; the configured expiry defaults to seven days.
  A shorter `JWT_EXPIRES_IN` or a future session-revocation/version mechanism
  reduces this window. Account deletion/role changes are checked on HTTP requests
  and new WebSocket connections; existing sockets close at expiry.
- **Critical if relied upon for paid orders: cloud card payment is still a demo integration.**
  [Viva webhook verification](src/lib/viva.ts) checks payload structure rather
  than a provider-authenticated, server-reconciled payment ledger; the checkout
  request includes a client-supplied amount. Do not treat frontend redirects or
  client payment session IDs as payment proof. The Pi rejects Viva checkout and
  takes payment at the venue. Cloud payment requires a separate verified-payment
  implementation; after this fix a cloud guest still needs valid QR approval.
- **Remote management must preserve offline operation.** Use the event-specific
  configuration export/import through a trusted local architect or authenticated outbound synchronization;
  do not expose the Pi database or copy cloud architect credentials into printed
  QR URLs. Changes on a disconnected Pi take effect only after the next import or
  successful sync. A printed URL's hostname cannot be changed by editing its
  destination record: changing that hostname requires DNS continuity or reprint.

## Dependency audit and verification

After the dependency updates, the current `npm audit --json` inventories report:

| Repository | Remaining advisories |
| --- | --- |
| Core | 3 high: `deepmerge-ts` and its `@prisma/config` / `prisma` dependency chain. This is the Prisma CLI configuration graph; no public endpoint accepts recursive Prisma configuration input. It still ships with database tooling and remains an upgrade item. No critical advisories remain. |
| Front | 0 |

Core uses the patched Fastify/CORS/rate-limit stack, bcrypt 6 and Node 24 container
builds; Front uses patched React Router/Vite dependencies. A forced Prisma
downgrade or untested major override was not used to hide the remaining report.
Audit counts describe dependency advisories, not a proof that all application
paths or container OS packages are safe. Re-run the audit before release because
the advisory database changes.

`npm run build` and `node --test tests/security-boundaries.test.mjs` passed for the
Core changes. Seven regression tests use an in-memory database boundary and real
loopback WebSockets to check cross-venue denial, node-secret suppression, guest
payload filtering, forged payment rejection, local venue exception, unknown-store
creation refusal, active upload rejection/sandboxing, and push SSRF rejection.
`tests/http-security.test.mjs` additionally covers the HTTP/auth controls. No
production database was queried by these tests, and no remote Pi/hardware test
was possible. The QR event management feature has its own integration checks.
