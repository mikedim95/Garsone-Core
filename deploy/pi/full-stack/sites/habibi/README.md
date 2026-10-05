# Habibi's local kitchen printer

The venue Pi uses Bluetooth printer `5A:4A:37:3D:A0:03` on RFCOMM channel 1,
bound to `/dev/rfcomm0`. Its existing menu routes use `kitchen`. Core writes
receipts directly through the durable local print queue. Keep the node's
Architect MQTT connection and local MQTT broker configured as before; do not
also configure an MQTT printer worker for this same device.

After pairing and trusting the printer with `bluetoothctl`:

1. Copy `bluetooth-0.conf` to `/etc/garsone/bluetooth-0.env` and the full-stack
   `garsone-rfcomm@.service` template to `/etc/systemd/system/`.
2. Copy `docker-bluetooth.conf` to
   `/etc/systemd/system/docker.service.d/garsone-bluetooth.conf`, reload systemd
   and enable/start `garsone-rfcomm@0.service`. Do not release a device in use.
3. Copy this directory's `compose.site.yml` to the full-stack directory. Set
   `BLUETOOTH_GID` in its private `.env` to `stat -c %g /dev/rfcomm0`. Keep
   `BLUETOOTH_ENABLED=false`: the venue override supplies the single device;
   the generic Bluetooth override is for two printers.
4. Recreate Core and the node using both `-f compose.yml -f compose.site.yml`
   with the existing image pins. Use `site.sh` for subsequent service actions
   so the venue override remains included.
5. Add `kitchen` to the local store's configured printer routes, preserving
   existing item assignments. Enable **Print on arrival** in the local Manager
   settings so customer checkout immediately queues a kitchen ticket. The
   equivalent authenticated local request is
   `PATCH /manager/store/print-on-arrival` with `{"enabled":true}`. This setting
   lives in Habibi's local database and survives code updates and restarts.

Both placed and preparing topics resolve to the same device. Normal kitchen
acceptance does not print again when print-on-arrival is enabled; an explicit
reprint remains available. Enabling the setting does not replay older orders.
If recovering a missed ticket, check its existing print jobs before reprinting.

Open **Manager → Local operations** for a labelled test ticket and queue status.
Pairing and a successful device write do not confirm physical paper output.
