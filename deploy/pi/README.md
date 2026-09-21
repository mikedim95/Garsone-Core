# Raspberry Pi Deployment

For the complete **Noor installation with no cloud runtime dependency and
direct Bluetooth printing**, use [full-stack/README.md](full-stack/README.md).
It includes a Noor data import, local assets, offline source/image
preparation, and compatibility with the existing GitHub image workflows.
QR Studio is a development tool and is excluded from the Pi deployment.

This bundle runs Garsone locally on a Raspberry Pi with three services:

- `front`: nginx serving the built React app
- `core`: Fastify API, realtime WebSocket gateway, Prisma
- `db`: local PostgreSQL with a persistent volume

For nodes associated through Architect, the preferred path is the per-store **Venue Deployment** tab. Architect sends a versioned deployment command to the node agent, which starts the same three-service topology, imports the selected venue, and reports its health. This manual bundle remains useful for standalone installations and recovery.

## Build And Push Images

Every push to `main` or `stage` builds and verifies the ARM64 Core image through
`.github/workflows/docker-publish.yml`. Configure these GitHub Actions secrets:

- `DOCKERHUB_USERNAME`
- `DOCKERHUB_TOKEN` (a Docker Hub access token with write permission)

`main` publishes the `pi`, `stable`, and immutable `stable-<git-sha>` tags.
`stage` publishes the `stage`, `canary`, and immutable
`canary-<git-sha>` tags. After the push, the workflow uses a short-lived GitHub
OIDC identity to register the immutable image digest with Garsone Core; no
long-lived release webhook secret is needed.

The Core Docker image defaults to `LOCAL_ONLY=true` and `TRUST_PROXY_HOPS=1`
for this Pi topology, including older managed nodes that omit those settings.
This keeps local guest checkout, QR imports and payment/push behavior aligned
with the Pi frontend. The single trusted proxy is Front's nginx; restrict direct
Core access at the network boundary. Compose explicitly connects Front to
`core:8787`; older managed deployments use `garsone-local-core:8787`.

Native hosted Node deployments do not inherit Docker defaults. If this image
is reused for a hosted container, explicitly set `LOCAL_ONLY=false`, set
`TRUST_PROXY_HOPS` to that deployment's verified proxy depth, and configure
the allowed frontend origins. Use the hosted frontend build for that deployment.

The local helper below remains available when a manual build is needed.

From the current two-repo workspace on your build machine:

```powershell
cd D:\Dev\Garsone\Garsone-Core
.\deploy\pi\build-and-push.ps1 -Namespace your-dockerhub-user -Tag pi
```

The script builds Linux ARM64 images and pushes:

- `your-dockerhub-user/garsone-core:pi`
- `your-dockerhub-user/garsone-front:pi`

Use `-AlsoLatest` if the Pis should pull `latest` too. For a 32-bit Pi OS,
rerun with `-Platform linux/arm/v7`.

## Run On The Pi

### One-Command Install

From your laptop, run this for each new Pi:

```bash
ssh -t piadmin@<pi-ip> "curl -fsSL https://raw.githubusercontent.com/mikedim95/Garsone-Core/main/deploy/pi/install.sh | bash -s -- --host <pi-ip>"
```

Or from the Pi itself:

```bash
curl -fsSL https://raw.githubusercontent.com/mikedim95/Garsone-Core/main/deploy/pi/install.sh | bash
```

The installer:

- installs Docker if needed
- creates `~/garsone-local`
- generates `.env` with local database and JWT secrets
- pulls `mikedim95/garsone-front:pi` and `mikedim95/garsone-core:pi`
- starts `front`, `core`, and `db` under the isolated `garsone-local` compose project
- seeds demo/architect data only when the local database is empty

The Docker Hub repositories are public, so the Pi does not need `docker login`.

Open the app at `http://<pi-host>:8080`; the API health endpoint is
`http://<pi-host>:8787/health`.

### Windows Helper

From this repo on Windows:

```powershell
.\deploy\pi\deploy-remote.ps1 -PiHost <pi-ip> -User piadmin
```

The SSH password prompt is normal on a fresh Pi unless you have keys set up.

### Manual Install

Manual deployment is still supported. Copy `compose.yml` and `.env.example` to
the Pi, create `.env`, then start:

```bash
docker compose --env-file .env -f compose.yml pull
docker compose --env-file .env -f compose.yml up -d
```

## Database Bootstrap

`DB_BOOTSTRAP_MODE=push` is the default for this Pi bundle because the repo has
incremental Prisma migrations but no baseline migration for an empty database.
The container uses Prisma's non-destructive push mode: schema changes that
would discard data fail the rollout instead of applying automatically.

Architect-managed code releases keep the local database authoritative. The
node creates a compressed `pg_dump` before replacing containers, retains the
three newest backups, health-checks the new Core and Front, and restores the
previous container images if the upgrade fails. Hosted venue data is imported
only on the first deployment or when Architect explicitly requests
**Sync venue data**; ordinary code releases do not overwrite local data.

The seed is not run automatically. To seed demo data once:

```bash
docker compose --env-file .env -f compose.yml --profile seed run --rm seed
```
