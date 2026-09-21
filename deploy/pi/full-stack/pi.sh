#!/usr/bin/env bash
# Execute from an extracted release on a 64-bit Linux Pi.
set -Eeuo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
action="${1:-check}"
compose=(docker compose --env-file .env -f compose.yml)
if [[ -f .env ]] && grep -qx 'BLUETOOTH_ENABLED=true' .env; then compose+=(-f compose.bluetooth.yml); fi
if [[ -f .env ]] && grep -qx 'QR_SYNC_ENABLED=true' .env; then compose+=(-f compose.qr-sync.yml); fi
if [[ -f images.lock.env ]] && ! grep -qx 'IMAGE_MODE=source' .env; then compose+=(--env-file images.lock.env); fi

check() {
  [[ "$(uname -s)" == Linux && "$(uname -m)" == aarch64 ]] || {
    echo 'This release requires 64-bit Linux (aarch64). Install 64-bit Pi OS before deployment.' >&2
    exit 1
  }
  command -v python3 >/dev/null
  docker info >/dev/null
  docker compose version >/dev/null
  if grep -qx 'QR_SYNC_ENABLED=true' .env; then
    [[ -f data/qr-sync.json && -s data/qr-sync.json ]] || {
      echo 'QR sync requires a private, nonempty data/qr-sync.json file. See EVENT_QR.md.' >&2
      exit 1
    }
  fi
  python3 prepare.py check
}

backup() {
  umask 077
  mkdir -p backups
  local dest="backups/$(date -u +%Y%m%d-%H%M%S)"
  mkdir "$dest"
  "${compose[@]}" exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$dest/database.dump"
  "${compose[@]}" exec -T core tar -C /app/uploads -czf - . > "$dest/uploads.tar.gz"
  cp .env "$dest/environment"
  "${compose[@]}" images --format json > "$dest/images.json"
  echo "Backup written to $dest; keep it together with the previous source release."
}

case "$action" in
  check) check ;;
  build)
    check
    grep -qx 'IMAGE_MODE=source' .env || { echo 'Source builds require prepare.py init --source.' >&2; exit 1; }
    "${compose[@]}" --profile printer build --pull core front printer
    "${compose[@]}" pull db
    ;;
  pull)
    check
    "${compose[@]}" pull db core front
    ;;
  start)
    check
    # Existing Pi installations keep their own data and ownership. Do not adopt automatically.
    if docker ps -a --format '{{.Names}}' | grep -Eq '^(garsone-node-agent|garsone-local-|garsone-venue-)'; then
      echo 'An existing managed/local Garsone installation was detected. Follow the migration section in README.md before starting this separate stack.' >&2
      exit 1
    fi
    if [[ -n "$("${compose[@]}" ps -q db)" ]]; then backup; fi
    "${compose[@]}" up -d --no-build --pull never --wait --wait-timeout 300
    "${compose[@]}" ps
    ;;
  backup) check; backup ;;
  import-noor)
    check
    [[ -f data/noor.local.json ]] || { echo 'Missing the reviewed Noor data bundle.' >&2; exit 1; }
    "${compose[@]}" up -d --pull never db
    "${compose[@]}" --profile import run --rm --pull never venue-import
    ;;
  admin) check; "${compose[@]}" --profile admin run --rm --pull never bootstrap-admin ;;
  seed-demo)
    check
    count="$("${compose[@]}" exec -T db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM stores"')"
    [[ "$count" == 0 ]] || { echo 'Refusing to seed a database containing stores.' >&2; exit 1; }
    "${compose[@]}" --profile seed run --rm seed
    ;;
  *) echo 'Usage: bash pi.sh {check|pull|build|import-noor|admin|start|backup|seed-demo}' >&2; exit 2 ;;
esac
