#!/bin/sh
set -eu

wait_for_database() {
  if [ -z "${DATABASE_URL:-}" ]; then
    return 0
  fi

  node --input-type=commonjs <<'NODE'
const net = require("node:net");

const rawUrl = process.env.DATABASE_URL;
const timeoutSeconds = Number(process.env.DB_WAIT_TIMEOUT_SECONDS || "60");

let host = "db";
let port = 5432;

try {
  const url = new URL(rawUrl);
  host = url.hostname || host;
  port = Number(url.port || "5432");
} catch {
  // Keep defaults when DATABASE_URL cannot be parsed.
}

const deadline = Date.now() + Math.max(1, timeoutSeconds) * 1000;

function tryConnect() {
  const socket = net.createConnection({ host, port });
  socket.setTimeout(2000);

  socket.on("connect", () => {
    socket.end();
    process.exit(0);
  });

  const retry = () => {
    socket.destroy();
    if (Date.now() > deadline) {
      console.error(`[entrypoint] database ${host}:${port} did not become reachable`);
      process.exit(1);
    }
    setTimeout(tryConnect, 1000);
  };

  socket.on("timeout", retry);
  socket.on("error", retry);
}

tryConnect();
NODE
}

if [ "${WAIT_FOR_DB:-true}" = "true" ]; then
  wait_for_database
fi

case "${DB_BOOTSTRAP_MODE:-migrate}" in
  migrate)
    npx prisma migrate deploy
    ;;
  push)
    npx prisma db push --skip-generate --accept-data-loss
    ;;
  none|skip)
    ;;
  *)
    echo "[entrypoint] unsupported DB_BOOTSTRAP_MODE=${DB_BOOTSTRAP_MODE}" >&2
    exit 1
    ;;
esac

if [ "${DB_SEED_ON_START:-false}" = "true" ]; then
  npm run db:seed
fi

exec "$@"
