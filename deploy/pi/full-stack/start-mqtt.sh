#!/bin/sh
set -eu
umask 077
mosquitto_passwd -b -c /mosquitto/data/passwords "$MQTT_USERNAME" "$MQTT_PASSWORD"
chown mosquitto:mosquitto /mosquitto/data /mosquitto/data/passwords
exec /usr/sbin/mosquitto -c /mosquitto/config/mosquitto.conf
