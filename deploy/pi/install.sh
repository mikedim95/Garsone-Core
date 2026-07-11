#!/usr/bin/env bash
set -Eeuo pipefail

REPO_BRANCH="${GARS0NE_REPO_BRANCH:-stage}"
BASE_URL="${GARS0NE_BASE_URL:-https://raw.githubusercontent.com/mikedim95/Garsone-Core/${REPO_BRANCH}/deploy/pi}"
APP_DIR="${GARS0NE_APP_DIR:-$HOME/garsone-local}"
PROJECT_NAME="${COMPOSE_PROJECT_NAME:-garsone-local}"
NAMESPACE="${DOCKERHUB_NAMESPACE:-mikedim95}"
IMAGE_TAG="${IMAGE_TAG:-pi}"
FRONT_PORT="${FRONT_PORT:-8080}"
CORE_PORT="${CORE_PORT:-8787}"
PUBLIC_HOST="${PUBLIC_HOST:-}"
PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-}"
SEED_ON_EMPTY_DB="${SEED_ON_EMPTY_DB:-1}"
INSTALL_DOCKER="${INSTALL_DOCKER:-1}"
FORCE_ENV="${FORCE_ENV:-0}"

usage() {
  cat <<USAGE
Install or update the local Garsone stack on a Raspberry Pi.

Usage:
  install.sh [options]

Options:
  --dir PATH            Install directory (default: ~/garsone-local)
  --project NAME        Compose project name (default: garsone-local)
  --namespace NAME      Docker Hub namespace (default: mikedim95)
  --tag TAG             Image tag (default: pi)
  --host HOST           Hostname or IP used by phones/tablets
  --origin URL          Full public frontend origin, e.g. http://pi.local:8080
  --front-port PORT     Host frontend port (default: 8080)
  --core-port PORT      Host backend port (default: 8787)
  --seed                Seed demo data when the database is empty (default)
  --no-seed             Do not run the seed
  --force-env           Regenerate .env even if it already exists
  --no-install-docker   Fail instead of installing Docker when missing
  -h, --help            Show this help

Environment variables with the same names can also be used.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --dir) APP_DIR="$2"; shift 2 ;;
    --project) PROJECT_NAME="$2"; shift 2 ;;
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --tag) IMAGE_TAG="$2"; shift 2 ;;
    --host) PUBLIC_HOST="$2"; shift 2 ;;
    --origin) PUBLIC_ORIGIN="$2"; shift 2 ;;
    --front-port) FRONT_PORT="$2"; shift 2 ;;
    --core-port) CORE_PORT="$2"; shift 2 ;;
    --seed) SEED_ON_EMPTY_DB=1; shift ;;
    --no-seed) SEED_ON_EMPTY_DB=0; shift ;;
    --force-env) FORCE_ENV=1; shift ;;
    --no-install-docker) INSTALL_DOCKER=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

log() {
  printf '[garsone-install] %s\n' "$*"
}

die() {
  printf '[garsone-install] ERROR: %s\n' "$*" >&2
  exit 1
}

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  else
    sudo "$@"
  fi
}

need_cmd() {
  command -v "$1" >/dev/null 2>&1
}

detect_public_host() {
  if [ -n "$PUBLIC_HOST" ]; then
    printf '%s' "$PUBLIC_HOST"
    return
  fi

  if need_cmd hostname; then
    local first_ip
    first_ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
    if [ -n "$first_ip" ]; then
      printf '%s' "$first_ip"
      return
    fi
    printf '%s.local' "$(hostname -s)"
    return
  fi

  printf 'localhost'
}

derive_origin() {
  if [ -n "$PUBLIC_ORIGIN" ]; then
    printf '%s' "${PUBLIC_ORIGIN%/}"
    return
  fi

  local host
  host="$(detect_public_host)"
  case "$host" in
    http://*|https://*) printf '%s' "${host%/}" ;;
    *:*) printf 'http://%s' "$host" ;;
    *) printf 'http://%s:%s' "$host" "$FRONT_PORT" ;;
  esac
}

derive_domain() {
  local origin="$1"
  printf '%s' "$origin" |
    sed -E 's#^https?://##; s#/.*$##; s#:[0-9]+$##'
}

secret_hex() {
  local bytes="$1"
  if need_cmd openssl; then
    openssl rand -hex "$bytes"
  else
    tr -dc 'a-f0-9' </dev/urandom | head -c "$((bytes * 2))"
  fi
}

check_platform() {
  local arch
  arch="$(uname -m)"
  case "$arch" in
    aarch64|arm64) ;;
    *)
      die "This installer expects 64-bit Raspberry Pi OS (aarch64/arm64). Detected: $arch"
      ;;
  esac
}

ensure_curl() {
  if need_cmd curl; then
    return
  fi
  log "Installing curl"
  run_root apt-get update
  run_root apt-get install -y ca-certificates curl
}

ensure_docker() {
  if need_cmd docker && docker info >/dev/null 2>&1; then
    DOCKER=(docker)
    return
  fi

  if need_cmd docker && run_root docker info >/dev/null 2>&1; then
    DOCKER=(sudo docker)
    return
  fi

  if [ "$INSTALL_DOCKER" != "1" ]; then
    die "Docker is not available. Re-run without --no-install-docker or install Docker first."
  fi

  log "Installing Docker"
  ensure_curl
  curl -fsSL https://get.docker.com | run_root sh
  run_root systemctl enable --now docker >/dev/null 2>&1 || true
  if [ -n "${USER:-}" ] && [ "$(id -u)" -ne 0 ]; then
    run_root usermod -aG docker "$USER" || true
  fi

  if docker info >/dev/null 2>&1; then
    DOCKER=(docker)
  elif run_root docker info >/dev/null 2>&1; then
    DOCKER=(sudo docker)
  else
    die "Docker installed but is not usable yet. Log out/in or reboot, then rerun this installer."
  fi
}

docker_cmd() {
  "${DOCKER[@]}" "$@"
}

compose() {
  docker_cmd compose --env-file "$APP_DIR/.env" -f "$APP_DIR/compose.yml" "$@"
}

write_env() {
  local origin domain protocol
  origin="$(derive_origin)"
  domain="$(derive_domain "$origin")"
  protocol="$(printf '%s' "$origin" | sed -E 's#://.*$##')"

  if [ -f "$APP_DIR/.env" ] && [ "$FORCE_ENV" != "1" ]; then
    log "Keeping existing $APP_DIR/.env"
    return
  fi

  log "Writing $APP_DIR/.env"
  umask 077
  cat >"$APP_DIR/.env" <<ENV
COMPOSE_PROJECT_NAME=${PROJECT_NAME}
DOCKERHUB_NAMESPACE=${NAMESPACE}
IMAGE_TAG=${IMAGE_TAG}
FRONT_PORT=${FRONT_PORT}
CORE_PORT=${CORE_PORT}
POSTGRES_DB=garsone
POSTGRES_USER=garsone
POSTGRES_PASSWORD=$(secret_hex 24)
JWT_SECRET=$(secret_hex 48)
DB_BOOTSTRAP_MODE=push
DB_WAIT_TIMEOUT_SECONDS=90
DB_SEED_ON_START=false
SEED_RESET=0
FRONTEND_ORIGIN=${origin}
FRONTEND_BASE_URL=${origin}
PUBLIC_APP_BASE_URL=${origin}
PUBLIC_APP_PROTOCOL=${protocol}
PUBLIC_APP_DOMAIN=${domain}
PUBLIC_APP_PORT=${FRONT_PORT}
FRONTEND_PORT=${FRONT_PORT}
MQTT_DISABLED=true
LOG_LEVEL=info
STORE_SLUG=default-store
ENABLE_DEV_LOGIN=0
ENV
}

download_compose() {
  log "Writing $APP_DIR/compose.yml"
  curl -fsSL "$BASE_URL/compose.yml" -o "$APP_DIR/compose.yml"
}

port_is_busy() {
  local port="$1"
  if need_cmd ss; then
    ss -tuln | awk '{print $5}' | grep -Eq "[:.]${port}$"
  else
    return 1
  fi
}

guard_ports() {
  local existing_project
  existing_project="$(docker_cmd ps --filter "label=com.docker.compose.project=${PROJECT_NAME}" --format '{{.Names}}' | head -n 1 || true)"
  if [ -n "$existing_project" ]; then
    return
  fi

  if port_is_busy "$FRONT_PORT"; then
    die "Port $FRONT_PORT is already in use. Re-run with --front-port PORT."
  fi
  if port_is_busy "$CORE_PORT"; then
    die "Port $CORE_PORT is already in use. Re-run with --core-port PORT."
  fi
}

seed_if_empty() {
  if [ "$SEED_ON_EMPTY_DB" != "1" ]; then
    return
  fi

  local count
  count="$(compose exec -T db psql -U garsone -d garsone -tAc 'select count(*) from stores;' 2>/dev/null | tr -d '[:space:]' || true)"
  if [ "$count" = "0" ]; then
    log "Seeding initial data"
    compose --profile seed run --rm seed
  else
    log "Skipping seed; stores table has $count row(s)"
  fi
}

main() {
  check_platform
  ensure_curl
  ensure_docker

  mkdir -p "$APP_DIR"
  chmod 700 "$APP_DIR"
  download_compose
  write_env
  guard_ports

  log "Pulling images"
  compose pull
  log "Starting Garsone"
  compose up -d
  seed_if_empty

  local origin
  origin="$(grep '^FRONTEND_ORIGIN=' "$APP_DIR/.env" | cut -d= -f2-)"
  log "Done"
  log "Frontend: ${origin}"
  log "API health: ${origin%:*}:${CORE_PORT}/health"
  log "Files: $APP_DIR"
}

main
