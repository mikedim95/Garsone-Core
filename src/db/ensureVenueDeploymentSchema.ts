import { db } from "./index.js";

async function main() {
  const statements = [
    `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PiReleaseChannel') THEN
        CREATE TYPE "PiReleaseChannel" AS ENUM ('STABLE', 'STAGE');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PiReleaseComponent') THEN
        CREATE TYPE "PiReleaseComponent" AS ENUM ('CORE', 'FRONT');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VenueDeploymentTarget') THEN
        CREATE TYPE "VenueDeploymentTarget" AS ENUM ('ONLINE', 'PI');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'VenueDeploymentDesiredState') THEN
        CREATE TYPE "VenueDeploymentDesiredState" AS ENUM ('STOPPED', 'RUNNING');
      END IF;
    END
    $$
    `,
    `
    CREATE TABLE IF NOT EXISTS "pi_releases" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "channel" "PiReleaseChannel" NOT NULL,
      "component" "PiReleaseComponent" NOT NULL,
      "imageRef" VARCHAR(600) NOT NULL,
      "sourceRepo" VARCHAR(255) NOT NULL,
      "sourceSha" VARCHAR(64) NOT NULL,
      "workflowRunId" VARCHAR(100),
      "publishedAt" TIMESTAMP(6) NOT NULL,
      "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    `,
    `
    CREATE TABLE IF NOT EXISTS "venue_deployments" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "storeId" UUID NOT NULL,
      "nodeId" UUID,
      "target" "VenueDeploymentTarget" NOT NULL DEFAULT 'ONLINE',
      "desiredState" "VenueDeploymentDesiredState" NOT NULL DEFAULT 'STOPPED',
      "autoUpdate" BOOLEAN NOT NULL DEFAULT true,
      "channel" "PiReleaseChannel" NOT NULL DEFAULT 'STABLE',
      "version" INTEGER NOT NULL DEFAULT 0,
      "appliedVersion" INTEGER NOT NULL DEFAULT 0,
      "dataSyncVersion" INTEGER NOT NULL DEFAULT 0,
      "appliedDataSyncVersion" INTEGER NOT NULL DEFAULT 0,
      "frontendPort" INTEGER NOT NULL DEFAULT 8080,
      "corePort" INTEGER NOT NULL DEFAULT 8787,
      "desiredCoreReleaseId" UUID,
      "desiredFrontReleaseId" UUID,
      "desiredCoreImageRef" VARCHAR(600),
      "desiredFrontImageRef" VARCHAR(600),
      "appliedCoreImageRef" VARCHAR(600),
      "appliedFrontImageRef" VARCHAR(600),
      "status" VARCHAR(32) NOT NULL DEFAULT 'ONLINE_ONLY',
      "message" VARCHAR(1000),
      "localUrl" VARCHAR(1000),
      "apiUrl" VARCHAR(1000),
      "servicesJson" JSONB,
      "requestedAt" TIMESTAMP(6),
      "lastReportedAt" TIMESTAMP(6),
      "lastBackupAt" TIMESTAMP(6),
      "lastBackupFile" VARCHAR(1000),
      "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "venue_deployments_storeId_fkey"
        FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "venue_deployments_nodeId_fkey"
        FOREIGN KEY ("nodeId") REFERENCES "node_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE,
      CONSTRAINT "venue_deployments_desiredCoreReleaseId_fkey"
        FOREIGN KEY ("desiredCoreReleaseId") REFERENCES "pi_releases"("id") ON DELETE SET NULL ON UPDATE CASCADE,
      CONSTRAINT "venue_deployments_desiredFrontReleaseId_fkey"
        FOREIGN KEY ("desiredFrontReleaseId") REFERENCES "pi_releases"("id") ON DELETE SET NULL ON UPDATE CASCADE
    )
    `,
    `
    CREATE TABLE IF NOT EXISTS "venue_deployment_events" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "deploymentId" UUID NOT NULL,
      "storeId" UUID NOT NULL,
      "nodeId" UUID,
      "releaseId" UUID,
      "version" INTEGER NOT NULL,
      "eventType" VARCHAR(64) NOT NULL,
      "status" VARCHAR(32) NOT NULL,
      "message" VARCHAR(1000),
      "metaJson" JSONB,
      "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "venue_deployment_events_deploymentId_fkey"
        FOREIGN KEY ("deploymentId") REFERENCES "venue_deployments"("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "venue_deployment_events_storeId_fkey"
        FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE,
      CONSTRAINT "venue_deployment_events_nodeId_fkey"
        FOREIGN KEY ("nodeId") REFERENCES "node_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE,
      CONSTRAINT "venue_deployment_events_releaseId_fkey"
        FOREIGN KEY ("releaseId") REFERENCES "pi_releases"("id") ON DELETE SET NULL ON UPDATE CASCADE
    )
    `,
    `CREATE UNIQUE INDEX IF NOT EXISTS "pi_releases_channel_component_sourceSha_key" ON "pi_releases"("channel", "component", "sourceSha")`,
    `CREATE INDEX IF NOT EXISTS "pi_releases_channel_component_publishedAt_idx" ON "pi_releases"("channel", "component", "publishedAt" DESC)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "venue_deployments_storeId_key" ON "venue_deployments"("storeId")`,
    `CREATE UNIQUE INDEX IF NOT EXISTS "venue_deployments_nodeId_key" ON "venue_deployments"("nodeId")`,
    `CREATE INDEX IF NOT EXISTS "venue_deployments_target_desiredState_autoUpdate_channel_idx" ON "venue_deployments"("target", "desiredState", "autoUpdate", "channel")`,
    `CREATE INDEX IF NOT EXISTS "venue_deployments_status_updatedAt_idx" ON "venue_deployments"("status", "updatedAt" DESC)`,
    `CREATE INDEX IF NOT EXISTS "venue_deployment_events_deploymentId_createdAt_idx" ON "venue_deployment_events"("deploymentId", "createdAt" DESC)`,
    `CREATE INDEX IF NOT EXISTS "venue_deployment_events_storeId_createdAt_idx" ON "venue_deployment_events"("storeId", "createdAt" DESC)`,
    `
    INSERT INTO "venue_deployments" (
      "storeId", "nodeId", "target", "desiredState", "autoUpdate", "channel",
      "version", "appliedVersion", "dataSyncVersion", "appliedDataSyncVersion",
      "frontendPort", "corePort", "desiredCoreImageRef", "desiredFrontImageRef",
      "status", "message", "localUrl", "apiUrl", "servicesJson",
      "requestedAt", "lastReportedAt", "createdAt", "updatedAt"
    )
    SELECT
      s."id",
      n."id",
      CASE WHEN d.value->>'target' = 'PI' THEN 'PI'::"VenueDeploymentTarget" ELSE 'ONLINE'::"VenueDeploymentTarget" END,
      CASE WHEN d.value->>'desiredState' = 'RUNNING' THEN 'RUNNING'::"VenueDeploymentDesiredState" ELSE 'STOPPED'::"VenueDeploymentDesiredState" END,
      true,
      CASE WHEN lower(COALESCE(d.value->>'imageTag', 'pi')) = 'stage' THEN 'STAGE'::"PiReleaseChannel" ELSE 'STABLE'::"PiReleaseChannel" END,
      CASE WHEN COALESCE(d.value->>'version', '') ~ '^[0-9]+$' THEN (d.value->>'version')::integer ELSE 0 END,
      CASE WHEN COALESCE(d.value->>'appliedVersion', '') ~ '^[0-9]+$' THEN (d.value->>'appliedVersion')::integer ELSE 0 END,
      CASE WHEN d.value->>'target' = 'PI' THEN 1 ELSE 0 END,
      CASE WHEN d.value->>'target' = 'PI' THEN 1 ELSE 0 END,
      CASE WHEN COALESCE(d.value->>'frontendPort', '') ~ '^[0-9]+$' THEN (d.value->>'frontendPort')::integer ELSE 8080 END,
      CASE WHEN COALESCE(d.value->>'corePort', '') ~ '^[0-9]+$' THEN (d.value->>'corePort')::integer ELSE 8787 END,
      COALESCE(NULLIF(d.value->>'imageNamespace', ''), 'mikedim95') || '/garsone-core:' || COALESCE(NULLIF(d.value->>'imageTag', ''), 'pi'),
      COALESCE(NULLIF(d.value->>'imageNamespace', ''), 'mikedim95') || '/garsone-front:' || COALESCE(NULLIF(d.value->>'imageTag', ''), 'pi'),
      COALESCE(NULLIF(d.value->>'status', ''), 'ONLINE_ONLY'),
      NULLIF(d.value->>'message', ''),
      NULLIF(d.value->>'localUrl', ''),
      NULLIF(d.value->>'apiUrl', ''),
      CASE WHEN jsonb_typeof(d.value->'services') = 'object' THEN d.value->'services' ELSE '{}'::jsonb END,
      CASE WHEN COALESCE(d.value->>'requestedAt', '') ~ '^\\d{4}-\\d{2}-\\d{2}T' THEN (d.value->>'requestedAt')::timestamp ELSE NULL END,
      CASE WHEN COALESCE(d.value->>'lastReportedAt', '') ~ '^\\d{4}-\\d{2}-\\d{2}T' THEN (d.value->>'lastReportedAt')::timestamp ELSE NULL END,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    FROM "stores" s
    CROSS JOIN LATERAL jsonb_each(
      CASE
        WHEN jsonb_typeof(s."settingsJson"->'venueDeployment') = 'object'
          THEN jsonb_build_object('venueDeployment', s."settingsJson"->'venueDeployment')
        ELSE '{}'::jsonb
      END
    ) d
    LEFT JOIN LATERAL (
      SELECT na."id"
      FROM "node_agents" na
      WHERE na."storeId" = s."id"
      ORDER BY na."createdAt" ASC
      LIMIT 1
    ) n ON true
    WHERE d.key = 'venueDeployment'
    ON CONFLICT ("storeId") DO NOTHING
    `,
  ];

  for (const statement of statements) {
    await db.$executeRawUnsafe(statement);
  }

  console.log("[db] Venue deployment schema ready");
}

main()
  .catch((error) => {
    console.error("[db] Failed to ensure venue deployment schema", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
