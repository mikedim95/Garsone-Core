# Noor on a standalone Raspberry Pi

The Pi is authoritative for Noor's database, staff login, menu, QR resolution,
orders, WebSocket updates, images and Bluetooth printing. There is no required
Render, Supabase, R2, Tailscale or MQTT connection at runtime. Customers must be
on the Pi's LAN/Wi-Fi and scan QR codes pointing to its stable local address.

Default containers: `db`, `core`, `front`. QR Studio remains a development
tool and is excluded from the Pi services and release bundles. Customer QR
resolution is handled by Core and Front. With Bluetooth enabled,
Core itself writes ESC/POS to the paired `/dev/rfcomm*` devices. The optional
`mqtt`, `printer`, and `node` profiles preserve legacy integrations; leave
them disabled for this Noor installation. `MQTT_DISABLED=true` is the default.

For cloud Architect control of each event's local QR addresses and table
assignments, follow [Event QR management](EVENT_QR.md). Export/import works
without an ongoing connection; optional outbound sync is disabled by default.
Review the [security findings](../../../SECURITY-REVIEW.md) before cutover.

## Existing GitHub release workflows

| Repository | Workflow | Published images |
| --- | --- | --- |
| Garsone-Core | `.github/workflows/docker-publish.yml` | `mikedim95/garsone-core:pi`, `stable`, `stable-<full SHA>` on main; stage/canary equivalents on stage |
| Garsone-Front | `.github/workflows/docker-publish.yml` | `mikedim95/garsone-front` with the same channels |
| Garsone-Nodes | `.github/workflows/docker-image.yml` | `mikedim95/mqtt-printer:latest`, `sha-<short SHA>`, version tags |

All existing workflows target ARM64. Core and Front register digest-pinned
releases with the hosted API using GitHub OIDC. That release-registration
mechanism remains in place; the standalone Pi does not need it to operate.
The Dockerfiles used by those workflows include the new local API/proxy and
direct-print code. Hosted Render builds still use their existing Node/Vite
commands. Initial verification was local; pushes to `main` trigger the existing
publication and release-registration workflows.

`images.published-before-prework.env` records the images found before these
changes. Those old images **do not contain this offline/direct-print work**.
After committing/reviewing and publishing these changes through the existing
workflows, run `python prepare.py lock-images` to write `images.lock.env`.
Both apps must be published before locking the pair. The release lock is
public metadata; it contains no passwords. Deploy Core/Front from that lock.
The Front image defaults to `CORE_UPSTREAM=garsone-local-core:8787` for older
Architect-managed nodes. This standalone Compose file explicitly overrides it
with `core:8787`, so both layouts work without an agent upgrade first.

## Prepared data

`data/noor.json` is the read-only production snapshot. `data/noor.local.json`
has menu image URLs rewritten to `/uploads/venue-import/...`; the image files
are under `data/uploads/`. Staff password hashes, table IDs and QR codes are
preserved. The snapshot also includes Noor's order history and related rows.
Other venues, cloud deployment instructions, node tokens and browser push
subscriptions are not imported. This directory is Git-ignored and excluded
from Docker build contexts and the public source bundle.

The export was taken on 2026-09-21. For a later cutover, take a fresh snapshot
after stopping order entry in the old system; changes after the snapshot are
not synchronized automatically. The Pi remains authoritative after import.
The original production database is never reset or seeded by these tools.

Refresh while production read access is available:

```powershell
# From Garsone-Core; RENDER_API_KEY is read from the process environment.
# Use a new filename; exports refuse to overwrite an existing snapshot.
node deploy/pi/full-stack/venue-data.mjs export deploy/pi/full-stack/data/noor-new.json
node deploy/pi/full-stack/venue-data.mjs assets deploy/pi/full-stack/data/noor-new.json
```

Alternatively set `SOURCE_DATABASE_URL` and run the export from a machine
with database access. The exporter uses a PostgreSQL read-only, repeatable-read
transaction. Access controls must allow the exporting machine.

## Prepare and transfer

The quickest path for this prepared release is the tested, prebuilt image
archive. Transfer the source archive, `garsone-images-arm64.tar.gz`, and
`noor-data.tar.gz` with their `.sha256` files. After extracting the source
archive and verifying the checksums, on the Pi run:

```bash
docker load -i /path/to/garsone-images-arm64.tar.gz
cd Garsone-Core/deploy/pi/full-stack
tar -xzf /path/to/noor-data.tar.gz
python3 prepare.py verify
python3 prepare.py init --prebuilt --host <stable-pi-LAN-IP-or-DNS-name>
bash pi.sh import-noor
bash pi.sh admin
bash pi.sh start
```

`--prebuilt` uses `images.prebuilt.json` to select the exact tested image tags;
the preflight also checks their image IDs. The image archive contains three
ARM64 runtime images: Core, Front and PostgreSQL. This path needs no registry access
or build on the Pi. Docker, Compose and Python must already be installed.
Hardware printing can be enabled afterward as described below. To recreate
the image archive after new local builds, use `python prepare.py images`
before generating the matching source bundle.

Use a 64-bit Raspberry Pi OS with Docker Engine 28+, Docker Compose v2, Python 3.9+
and BlueZ. Keep database/uploads on persistent storage with adequate free space.
Building on the Pi requires internet access to fetch base images/packages;
running preloaded images with the data bundle does not.

```powershell
# From Garsone-Core/deploy/pi/full-stack on this laptop:
python prepare.py bundle
```

The resulting source archive preserves the Core, Front and Nodes sibling
source directories and records Git commits plus SHA-256 hashes in
`release-manifest.json`. Nodes is included for the optional legacy profiles.
Transfer it and the private `noor-data.tar.gz` from `artifacts/` via SCP when
SSH becomes available. Treat the data archive as confidential (staff hashes
and order history). Neither archive contains the laptop's .env or API keys.

On the Pi, in a fresh release directory:

```bash
sha256sum -c garsone-pi-<timestamp>.tar.gz.sha256
tar -xzf garsone-pi-<timestamp>.tar.gz
cd Garsone-Core/deploy/pi/full-stack
python3 prepare.py verify
tar -xzf /path/to/noor-data.tar.gz
python3 prepare.py init --host <stable-pi-LAN-IP-or-DNS-name>
```

Edit `.env` before starting: use `STORE_SLUG=noor`, the actual public host,
and matching `PUBLIC_ORIGIN=http://<host>:8080`. Phones resolve the public
host; only containers use names such as `core` and `db`. Reserve the Pi IP in
DHCP or configure local DNS. Do not use `localhost` for customer QR codes.

For the published-image path, copy the post-publication `images.lock.env`
and run `bash pi.sh pull`. While these changes are only local, initialize
with `python3 prepare.py init --source --host <host>` instead, then run
`bash pi.sh build`. Source mode uses separate local image tags and ignores
the published-image lock. `init` refuses to overwrite an existing `.env`.

Then, before letting users open the app:

```bash
bash pi.sh import-noor   # Refuses any DB already containing stores/profiles
bash pi.sh admin         # Adds a local architect without changing staff passwords
bash pi.sh start
```

Read `LOCAL_ADMIN_EMAIL`/`LOCAL_ADMIN_PASSWORD` from the Pi's `.env` to log in
at `http://<pi>:8080/login`. Existing Noor staff log in with their existing
credentials.

## Direct Bluetooth printing

The configured devices must be Bluetooth Classic SPP/RFCOMM ESC/POS printers,
matching the existing printer runtime. BLE-only printers require another
transport. Hardware pairing and paper output cannot be proven without the Pi.

Noor currently uses **printer_1 and printer_2** and prints on order arrival.
`printers.json` routes both `placed` and manual `preparing` print events to
`rfcomm0` / `rfcomm1`. This does not reprint generic order status broadcasts.
Review the physical routing before enabling it. Noor's current production
node configuration was exported separately to `data/noor-hardware.json`, and
matching `data/bluetooth-0.env` / `bluetooth-1.env` files are prepared. These
identify the two saved 58 mm printers; their live pairing and SPP channels
still need confirmation on the Pi. Channel 1 is a provisional default.

On the Pi, install/enable BlueZ if needed, then pair and trust each actual
printer with `bluetoothctl` (power on, agent on, default-agent, scan on,
pair MAC, trust MAC). Determine its SPP channel; 1 is common but not guaranteed.

```bash
sudo bash bluetooth-bind.sh <printer-1-MAC> 1 0
sudo bash bluetooth-bind.sh <printer-2-MAC> 1 1
stat -c '%n %g' /dev/rfcomm0 /dev/rfcomm1
```

Set `BLUETOOTH_GID` to the owning group ID, and `BLUETOOTH_ENABLED=true` in
`.env`. Core remains a non-root container with only those device mappings.
For one physical printer, point all routes to `/dev/rfcomm0` and remove the
second `devices` entry in `compose.bluetooth.yml`. For different device
groups, add the second numeric GID to `group_add` as well.

Persist the binding at boot using a host systemd oneshot service that runs
`rfcomm bind` after `bluetooth.service`, before the application starts. BlueZ
pairing keys persist on the host. If rebinding changes device nodes while
containers are running, recreate Core to refresh Docker's device mappings.

Templates `garsone-rfcomm@.service` and `garsone-noor.service` are included.
Create `/etc/garsone/bluetooth-0.env` and `bluetooth-1.env` containing `INDEX`,
`MAC` and `CHANNEL`; customize the application's `WorkingDirectory`, install
the units in `/etc/systemd/system`, and enable `garsone-noor.service`. Its
dependencies bind both devices before bringing the application up, including
after reboot. For one printer, remove the second unit dependency as well.

The application stores pending tickets in `print-spool`, serializes writes
per device, uses CP1253/ESC t 7 by default, and bounds each device write to
20 seconds. Printer codepages/cut settings must be verified on paper.
The kernel accepting bytes does not prove a physical receipt printed.
Failed or interrupted writes remain `uncertain` and are **not** automatically
retried; inspect the printer, then explicitly reprint from the order UI.
Authenticated managers can inspect `GET /api/manager/local-printing`.
Do not run the legacy MQTT printer profile on the same devices.

## Local URLs and independence checks

| Consumer | Destination |
| --- | --- |
| Customer/staff browser | `http://<pi>:8080` |
| Browser HTTP and WebSocket | same origin `/api/...` and `/api/events/ws` |
| nginx to Core | `http://core:8787` (or agent-provided CORE_UPSTREAM) |
| Core to Postgres | `db:5432` inside Docker |
| Receipt output | Core -> local `/dev/rfcomm0` or `/dev/rfcomm1` |
| Images | same origin `/uploads/...` or bundled frontend assets |

Viva online payment is hidden in the local container build. Card-processing
providers and browser web-push services inherently need internet; the local
workflow uses pay-at-venue and live WebSocket updates. No VAPID, R2, Supabase,
Viva or hosted database credentials are passed to the local containers.

After import, disconnect the router's WAN (keep LAN/Wi-Fi running), log in
with a Noor staff account, scan a newly printed local QR, place an order,
observe cook/waiter updates and print it. Restart the stack and confirm data
persists. Old QR stickers pointing at garsone.gr need new local URLs; copying
their database assignments alone cannot change what is printed on a sticker.

## Backup, upgrades and recovery

`bash pi.sh backup` saves a custom-format database dump, uploads, the private
environment and image metadata. `start` backs up an already-running DB before
replacing containers. Keep the previous release and its image lock. Startup
uses non-destructive Prisma `db push`; there is no complete baseline migration.
There is no automatic standalone schema rollback. Restore backups into fresh
volumes with the previous release after a failed incompatible schema change.
Never use `docker compose down -v` against a venue installation.

Do not start this stack alongside an existing `garsone-local` or
Architect-managed Pi deployment. The start helper detects those containers
and stops. First back up and plan an explicit data/ownership cutover; it does
not automatically remove old containers or reuse their volumes.

Reference semantics: [Compose health dependencies](https://docs.docker.com/compose/how-tos/startup-order/),
[BlueZ RFCOMM](https://manpages.debian.org/bookworm/bluez/rfcomm.1.en.html),
[Render Postgres external access](https://render.com/docs/postgresql-creating-connecting).
