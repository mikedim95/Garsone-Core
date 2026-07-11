# Raspberry Pi Deployment

This bundle runs Garsone locally on a Raspberry Pi with three services:

- `front`: nginx serving the built React app
- `core`: Fastify API, realtime WebSocket gateway, Prisma
- `db`: local PostgreSQL with a persistent volume

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

Copy `compose.yml` and `.env.example` to the Pi, then create the real `.env`:

```bash
cp .env.example .env
nano .env
```

Set at minimum:

- `DOCKERHUB_NAMESPACE`
- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- the `FRONTEND_*` / `PUBLIC_APP_*` URLs to the Pi hostname or LAN IP

Then start:

```bash
docker login
docker compose --env-file .env -f compose.yml pull
docker compose --env-file .env -f compose.yml up -d
```

`docker login` is only required when the Docker Hub repositories are private.

Open the app at `http://<pi-host>:8080`; the API health endpoint is
`http://<pi-host>:8787/health`.

## Database Bootstrap

`DB_BOOTSTRAP_MODE=push` is the default for this Pi bundle because the repo has
incremental Prisma migrations but no baseline migration for an empty database.
After the first successful boot, keep `push` for simple local updates or change
to `none` if you want to manage schema changes manually.

The seed is not run automatically. To seed demo data once:

```bash
docker compose --env-file .env -f compose.yml --profile seed run --rm seed
```
