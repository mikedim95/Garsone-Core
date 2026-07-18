# Raspberry Pi Deployment

This bundle runs Garsone locally on a Raspberry Pi with three services:

- `front`: nginx serving the built React app
- `core`: Fastify API, realtime WebSocket gateway, Prisma
- `db`: local PostgreSQL with a persistent volume

For nodes associated through Architect, the preferred path is the per-store **Venue Deployment** tab. Architect sends a versioned deployment command to the node agent, which starts the same three-service topology, imports the selected venue, and reports its health. This manual bundle remains useful for standalone installations and recovery.

## Build And Push Images

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
ssh -t piadmin@<pi-ip> "curl -fsSL https://raw.githubusercontent.com/mikedim95/Garsone-Core/stage/deploy/pi/install.sh | bash -s -- --host <pi-ip>"
```

Or from the Pi itself:

```bash
curl -fsSL https://raw.githubusercontent.com/mikedim95/Garsone-Core/stage/deploy/pi/install.sh | bash
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
After the first successful boot, keep `push` for simple local updates or change
to `none` if you want to manage schema changes manually.

The seed is not run automatically. To seed demo data once:

```bash
docker compose --env-file .env -f compose.yml --profile seed run --rm seed
```
