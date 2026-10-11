# Standalone Pi installation — 2026-10-11

**Current operating mode: online printing.** At 21:30 Athens time the user
requested continued operation through the existing online Noor QR codes.
The local stack below is now stopped and preserved; dedicated cloud MQTT
printer workers are active. See [online printing](../online-printing/README.md)
for the cutover, verification, and service controls. The static IP is unchanged.

The installation at `100.91.30.75` was prepared with the current Core and Front and a
fresh, independent copy of the Render production database. When standalone
mode is active, customer traffic uses `http://192.168.1.116:8080` on the venue LAN. Remote administration can use
`http://100.91.30.75:8080`. Staff password hashes were preserved from Render;
local staff sign in at `/login`. Architect remains an online-only role.

After installation, the Pi was configured to keep `192.168.1.116/24` as a
persistent static address on the `NOOR` Wi-Fi profile only. Gateway and DNS
remain `192.168.1.1`. The address itself and all QR records were left unchanged
during this networking follow-up. Existing Noor QR codes remain for the online
instance; future QR codes intended for this local Pi can use
`http://192.168.1.116:8080`.

The NetworkManager profile UUID is
`521af7c3-7d52-4153-bddc-3da1f5a60f63` (`garsone-wifi-5`, interface `wlan0`).
The reviewed `Garsone-Nodes/static_network.py` helper was installed at
`/usr/local/lib/garsone/static_network.py`. A ten-minute checkpoint protected
the temporary change; it was confirmed only after fresh direct LAN SSH and
HTTP health checks. The saved keyfile was verified to contain `method=manual`,
the same address, gateway and DNS. Live address lifetime is unlimited, the
default route is static, DNS works, Tailscale remains reachable, and all three
app containers remain healthy. No full hardware reboot was performed.

The original Wi-Fi profile is retained privately under
`/var/lib/garsone/network/01a1b7fe38e4422ba628c22e9eca405a/`. This is a Pi-side
static setting; the router DHCP pool/reservations were not changed. Reserve or
exclude this address on the router to prevent it being offered to another
device. Other saved Wi-Fi profiles retain their existing settings.

All nine existing Noor QR codes were verified through read-only requests to
the online API: each returned `status: OK` for `noor` and an HTTP 302 redirect
to `https://www.garsone.gr/table/...?...storeSlug=noor`. The online menu still
returns five categories and 54 items. Redirects were not followed, so these
checks created no online customer visits or orders. No QR codes were issued,
modified, or reassigned during the networking follow-up.

## Installed release

- Release directory: `/opt/garsone/releases/20261011-standalone`.
- Active symlink: `/opt/garsone/current`.
- Compose project: `garsone-standalone-20261011`.
- Core source: `6a8e4b93b75330b61509dbad057eb9a8f5821f83`.
- Core image: `garsone/core:standalone-6a8e4b93b753`, image ID
  `sha256:4d2accd9d7cad5de13206ce14c63e560e9a96f672f6fefe10cbf67cc64974109`.
- Front source: `0f28da07694f4ee93da289dd663c42b395d20b11`, published image digest
  `sha256:78336b744485b4546e9e33c9eeaba22e6252e30f45f3114d6c9af6bbb82052ff`.
- PostgreSQL 18 uses a fresh persistent volume mounted at
  `/var/lib/postgresql`; its exact image digest is in `images.lock.env`.

The latest Core publication workflow had been cancelled. Its exact committed
source was built with the repository Dockerfile on the ARM64 Pi, then tested.
No cloud publication workflow was run as part of this installation. Future
routine updates can use the existing published-image updater once the desired
Core and Front revisions have successful image builds.

In standalone mode, only `db`, `core`, and `front` run. Core uses local PostgreSQL and local uploads,
and writes directly to the Bluetooth devices. MQTT, node agents, cloud QR sync,
hosted payment, and browser push services are disabled for this installation.
New local secrets were generated; no hosted database credentials were passed
to the application containers.

## Database and images

Render's built-in logical export completed at `2026-10-11T17:57:00Z`
(`20:57` in Athens). The source database contents, access rules, application
configuration, and live deployments were not modified. Requesting the export
created a downloadable backup in Render.

The downloaded archive has SHA-256
`3a435c7237a2360dc92459bf752823047f3a4fcc1536e89b4d250d0ae0d82f9d`.
It was validated through gzip EOF and restored with `pg_restore` into the empty
new local database. All 38 restored tables matched the export's COPY row
counts: 90,152 rows. The copy includes all source stores. Noor remains the
installation's default store, with 54 menu items and 11 historical orders.

All 59 catalogue image URLs were downloaded and rewritten to local uploads.
Existing local uploads were also preserved. QR event app/API origins were
rewritten only in the Pi copy. The import checks pending print intents to
prevent replaying historical cloud tickets; this export contained none queued.

This is a snapshot, with no subsequent synchronization to or from Render.

## Verification and printing

- All three containers became healthy before and after the cutover.
- Fifteen focused tests passed inside the new Core image, covering security,
  local login restrictions, and durable print queue behavior.
- Browser tests passed for Manager login, 54 menu items, 54 item images, QR
  resolution and LAN redirects, WebSocket connectivity, and local operations.
- A mobile-sized browser followed a disposable customer QR over the actual
  LAN address and established an active guest visit without external requests.
- Application-container internet access was blocked during these checks and
  the service restart. The tested app continued working. The temporary
  firewall rule was removed afterward.
- During standalone verification, `garsone-noor.service` was enabled and successfully restarted the new stack.
  A full hardware reboot and an in-person phone/paper observation were not
  performed during this installation.
- Temporary verification staff, table, QR, and visit records were removed.
  All 38 table counts again matched the original export before the completion
  ticket was added. No test customer order was created.
- Completion ticket `6208cf29-3458-418d-92be-43482ed01a0f` reached `delivered`
  with no error at `2026-10-11T18:07:47.796Z`, using `/dev/rfcomm0`.
  This confirms the device write; physical paper appearance was not observed.
  The second configured Bluetooth printer was offline during installation.

## Recovery and operation

Private backups remain on the Pi:

- `/opt/garsone/backups/pre-standalone-20261011`: old local database, uploads,
  print spool, Compose configuration, secrets, and service configuration.
- `/opt/garsone/backups/standalone-installed-20261011`: validated installed
  database, assets, spool, configuration, and installation evidence.

Both database dumps passed `pg_restore --list`; compressed volume archives
were drained through gzip EOF. The fresh-volume Render restore was performed
and its row counts checked, rather than only inspecting the archive.

The old release and old `garsone-noor` volumes remain intact for recovery.
Old containers are stopped with automatic restart disabled. Rollback must be
an explicit maintenance operation: stop the new installation, point `current`
at the recorded old release, restore the old containers' restart policies,
and start the service. Doing this after new orders exist requires a data review
because the old and new databases are independent. Never remove venue volumes
with `docker compose down -v`.

For normal service operations:

```sh
sudo systemctl status garsone-noor.service
cd /opt/garsone/current/Garsone-Core/deploy/pi/full-stack
bash site.sh ps
```

The documentation commit uses `[skip render] [skip ci]` to preserve the hosted
deployment and avoid the image workflow's cloud release-registration callback.
