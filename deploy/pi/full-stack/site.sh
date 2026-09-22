#!/usr/bin/env bash
# Start the installed image pins. Downloads and upgrades are explicit update.py actions.
set -Eeuo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
case "${1:-check}" in
  start|stop)
    # Let the deployment owner invoke updates even if systemd starts this script as root.
    if [[ ! -e .update.lock ]]; then
      touch .update.lock
      if [[ "$(id -u)" == 0 ]]; then chown --reference=.env .update.lock; fi
      chmod 600 .update.lock
    fi
    exec 9>.update.lock
    flock -n 9 || { echo 'An application update or service action is already running.' >&2; exit 1; }
    ;;
esac
compose=(docker compose --env-file .env -f compose.yml)
if [[ -f images.lock.env ]]; then compose+=(--env-file images.lock.env); fi
if [[ -f compose.site.yml ]]; then compose+=(-f compose.site.yml); fi
if grep -qx 'BLUETOOTH_ENABLED=true' .env; then compose+=(-f compose.bluetooth.yml); fi
if grep -qx 'QR_SYNC_ENABLED=true' .env; then compose+=(-f compose.qr-sync.yml); fi
case "${1:-check}" in
  check) python3 prepare.py check; "${compose[@]}" config --quiet ;;
  start) python3 prepare.py check; "${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 300 db core front ;;
  stop) "${compose[@]}" stop ;;
  *) "${compose[@]}" "$@" ;;
esac
