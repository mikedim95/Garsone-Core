#!/usr/bin/env bash
set -euo pipefail
# Run after bluetoothctl pair/trust; binding connects on device open.
mac="${1:-}"
channel="${2:-1}"
index="${3:-0}"
[[ "$mac" =~ ^([[:xdigit:]]{2}:){5}[[:xdigit:]]{2}$ ]] || { echo 'Usage: sudo bash bluetooth-bind.sh MAC [SPP-channel]' >&2; exit 2; }
[[ "$channel" =~ ^[0-9]+$ ]] && ((channel >= 1 && channel <= 30)) || exit 2
[[ "$index" =~ ^[0-9]+$ ]] || exit 2
[[ "$EUID" == 0 ]] || { echo 'Run with sudo.' >&2; exit 1; }
command -v rfcomm >/dev/null
systemctl start bluetooth
if [[ -e "/dev/rfcomm${index}" ]]; then
  echo "rfcomm${index} already exists. Inspect: rfcomm show ${index}. Existing binding was preserved."
  exit 1
fi
rfcomm bind "$index" "$mac" "$channel"
echo "Bound /dev/rfcomm${index}. Record its group with: stat -c %g /dev/rfcomm${index}"
