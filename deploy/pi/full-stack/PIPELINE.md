# Commit to Raspberry Pi

Application changes reach the Pi through GitHub Actions and Docker Hub. The Pi
downloads published ARM64 images; neither this computer nor the Pi needs to build
application images for an update.

```mermaid
flowchart LR
  A[Edit and test locally] --> B[Commit and push]
  B --> C[GitHub Actions: test and build ARM64]
  C --> D[Docker Hub: image tagged with commit SHA]
  D --> E[Run the Pi updater]
  E --> F[Pin image digests and verify healthy containers]
```

Core and Front are separate repositories. Commit and push changes in each
repository that changed, then wait for its `docker-publish.yml` workflow to
succeed. A Front-only change does not require a new Core commit or image.

| Git branch | Updater channel | Exact image tag |
| --- | --- | --- |
| `main` | `stable` | `stable-<full commit SHA>` |
| `stage` | `stage` | `canary-<full commit SHA>` |

The repositories publish `mikedim95/garsone-core` and
`mikedim95/garsone-front`. Moving aliases such as `pi`, `stable`, `stage` and
`canary` also exist, but the updater selects exact commit tags and records their
immutable Docker digests in `images.lock.env`. Registration with the cloud
Render API is best effort and is not required for standalone publication or
deployment.

## Preview and install

From the `Garsone-Core` directory on this computer:

```powershell
# Inspect available and installed versions; no download or restart.
python deploy/pi/full-stack/update.py check --host piadmin@100.91.30.75

# Install changed Core and Front images after their workflows succeed.
python deploy/pi/full-stack/update.py apply --host piadmin@100.91.30.75

# Install only Front; leave Core and the database running.
python deploy/pi/full-stack/update.py apply --host piadmin@100.91.30.75 --component front
```

The remote directory defaults to
`/opt/garsone/current/Garsone-Core/deploy/pi/full-stack`. Use `--remote-dir`
when an installation lives elsewhere. SSH access to the Pi is required for
these remote commands.

Alternatively, run the updater directly on the Pi:

```bash
cd /opt/garsone/current/Garsone-Core/deploy/pi/full-stack
python3 update.py check
python3 update.py apply
```

Both commands accept `--component all|core|front` (default `all`) and
`--channel stable|stage` (default `stable`). By default, each selected component
uses the latest successful publication workflow commit for that channel. To
deploy a reviewed pair or a specific earlier image, supply `--core-sha` and/or
`--front-sha`, using the full 40-character commit SHA. For example:

```powershell
python deploy/pi/full-stack/update.py apply --host piadmin@100.91.30.75 --component front --front-sha <full-40-character-Front-commit-SHA>
```

Replace the placeholder with the actual commit. Exact SHA tags must already
have been published to Docker Hub. When Core and Front changes depend on each
other, wait for both workflows and supply both SHAs to deploy the intended pair.

`check` reports installed references and resolves the candidate versions without
downloading images or restarting services. `apply` pulls the selected images
from Docker Hub, validates Linux ARM64 support, pins their digests and updates
only changed applications. Images are downloaded before application downtime.

## Data, downtime and recovery

A Front-only update replaces Front while Core and PostgreSQL remain running.
If the new Front fails its checks, the updater automatically restores the
previous Front image.

A Core update briefly closes customer access and stops Core writers. It backs
up the database, uploads, print spool and configuration before starting the new
Core. Once Core is healthy, it recreates Front so nginx reconnects to the current
Core container. Local settings, Bluetooth configuration, optional QR sync,
database contents and persistent volumes are retained. An application update
does not reimport the Noor snapshot or upgrade PostgreSQL.

Core startup applies schema changes with Prisma's non-destructive `db push`;
changes requiring data loss are refused. Reverting an image does not revert its
database schema. If a Core update fails, the updater restores the previous image
pins, but keeps customer access closed when a safe restart cannot be established.
Use its failure report and saved backups to complete recovery. There is no
automatic database restore that could discard newer orders. Never run
`docker compose down -v` as an update or recovery step.

## Offline operation and startup

Checking for releases and downloading updates need internet access. Customer
menus, staff login, orders, the local database and direct Bluetooth printing
continue to run locally without it. GitHub, Docker Hub and Render are not needed
to serve customers after installation.

Boot starts the installed, pinned images already stored on the Pi; it never
fetches the latest release. Automatic updates are **not enabled** unless they
are subsequently configured explicitly. A push publishes an image; the
`apply` command chooses when that image becomes live at the venue.
