# Noor online printing on the Pi

As of 2026-10-11 at 21:30 Athens time, Noor uses its existing online application
and QR codes. The Pi runs two MQTT Bluetooth printer workers. The standalone
application and copied database remain installed, stopped, and preserved.

The online order submitted at 21:24:14 was accepted by Core with HTTP 201.
Online `printOnArrival` was already enabled. The Pi's online subscribers had
been stopped, so the published receipt had no local consumer. Restoring them
requires no change to Render, application settings, or QR records.

## Installed configuration

- Pi: `100.91.30.75`; unchanged static LAN address `192.168.1.116/24` on NOOR.
- Working directory: `/opt/garsone/online-printing`, root-owned, mode `0700`.
- `compose.yml` is the manifest in this directory. It pins the previously
  installed ARM64 printer image and directly runs `mqtt_print_orders.py`.
  The worker script from `Garsone-Nodes/MQTT_Printer/mqtt_print_orders.py` is
  installed alongside the manifest and mounted read-only over the image copy.
  The installed transport revision is Garsone-Nodes commit `5ec01a2`.
  Copy that file before starting Compose on a fresh installation.
- Private `printer-1.env` and `printer-2.env` files have mode `0600`. They were
  generated from `/var/lib/garsone-node/last-config.json`, including existing
  MQTT credentials. Never commit these files.
- Each worker subscribes to `noor/orders/placed/printer_N` and
  `noor/orders/preparing/printer_N` using TLS with certificate verification.
- Printer 1 uses `/dev/rfcomm0`; printer 2 uses `/dev/rfcomm1`. Existing host
  `rfcomm-printers.service` supplies both Bluetooth bindings. Printer 2 was
  offline during the earlier standalone installation; its physical output
  has not been verified.
- Worker client IDs remain `noor-node/noor/printer_1` and
  `noor-node/noor/printer_2`. Automatic startup tickets are disabled.
- No node agent, networking reconciler, cloud QR sync, or watchtower runs.
  Printer workers do not send node-agent heartbeats to Architect.

`garsone-noor-online.service` is installed under `/etc/systemd/system` and is
enabled at boot. `online-mode.conf` is installed at
`/etc/systemd/system/garsone-noor.service.d/online-mode.conf`. The two services
conflict and have explicit ordering so the running service stops before the
other starts. The installed standalone unit has `ExecStop=bash site.sh stop`
to stop its actual Compose project; preserve this when replacing that unit.
The standalone service is disabled and its three stopped containers have
`restart=no`. Their volumes, source release, assets, and backups are intact.

## Verification and operation

Both workers connected to the cloud broker with `rc=0` and subscribed to their
two exact topics. A non-retained test message, `online-restored-20261011`, sent
through the cloud broker to `noor/orders/placed/printer_1` was received,
rendered, and written successfully at 21:30:37 Athens time (`Print ok`). No
customer order was created or changed for this check. This confirms the device
write; physical paper appearance requires observation at the venue.
The online service was also restarted successfully and both subscriptions
reconnected. No full hardware reboot was performed.

### Bluetooth output follow-up

The user confirmed the correct printer MAC is `66:32:6C:7A:6B:36` and reported
that the earlier tests did not produce paper despite `Print ok` logs. The
binding already used this address. A plain-text `TEST A` with raw serial mode,
complete writes, output drain, and a two-second connection hold printed
successfully, as confirmed at the venue. The printer also answered a status
query. A subsequent `TEST B ONLINE` through the normal cloud MQTT worker was
confirmed on paper. Neither the MAC nor the online topics needed changing.

The installed worker now applies those serial settings on every write, checks
all bytes, drains output, and waits two seconds before closing. Its entire
device operation has a 20-second deadline and does not automatically replay an
uncertain ticket. Logging distinguishes a completed device write from physical
printing; paper output still requires observation. These changes preserve the
tested connection behavior without claiming that disconnect timing alone
caused the earlier failure.

All seven transport tests passed inside the Pi runtime image, including a
Linux pseudo-terminal check for exact binary output, incomplete writes,
disconnects, and timeout handling. After recreating the workers, the cloud
`FINAL ONLINE TEST` completed its 230-byte device write at 21:52:00 Athens
time. The user confirmed that this final ticket printed. The online service
remains enabled at boot; no full hardware reboot was performed.

```sh
sudo systemctl status garsone-noor-online.service
sudo docker compose -f /opt/garsone/online-printing/compose.yml ps
sudo docker compose -f /opt/garsone/online-printing/compose.yml logs --tail 50
```

The existing worker uses clean MQTT sessions and QoS 0 subscriptions, without
a durable receipt queue. The earlier missed receipt does not replay after
reconnection; reprint it from the online application. Never publish historical
orders in bulk to recover one ticket.

Returning to standalone is an explicit future cutover: stop and disable the
online service, then enable and start `garsone-noor.service`. Check that Compose
has restored the standalone containers' configured restart policies, verify
the local app, and plan customer QR usage. The local database is a snapshot;
online orders received since the export are not synchronized into it. Do not
start standalone Compose directly while online workers own the devices.

The prior service configuration is saved privately at
`/opt/garsone/backups/online-printing-switch-20261011`. See the
[standalone installation record](../full-stack/DEPLOYMENT-2026-10-11.md) for
the preserved release, database export, backups, and static network details.
