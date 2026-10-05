#!/bin/sh
set -eu
umask 077
# Mosquitto 2.1 refuses -c when the destination already exists. Generate in
# a private temporary directory, then atomically replace only the password
# file. Existing messages/sessions in mosquitto.db survive every restart.
temporary="$(mktemp -d /mosquitto/data/.auth.XXXXXX)"
trap 'rm -f "$temporary/passwords"; rmdir "$temporary" 2>/dev/null || true' EXIT
mosquitto_passwd -b -c "$temporary/passwords" "$MQTT_USERNAME" "$MQTT_PASSWORD"
chmod 600 "$temporary/passwords"
chown mosquitto:mosquitto /mosquitto/data "$temporary/passwords"
mv -f "$temporary/passwords" /mosquitto/data/passwords
rmdir "$temporary"
trap - EXIT
exec /usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf
