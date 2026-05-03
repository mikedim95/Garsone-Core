CREATE TYPE "NodeAgentStatus" AS ENUM ('PENDING', 'ONLINE', 'APPLYING', 'DEGRADED', 'ERROR', 'OFFLINE');

CREATE TABLE IF NOT EXISTS "node_agents" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "storeId" UUID NOT NULL,
  "slug" VARCHAR(100) NOT NULL,
  "displayName" VARCHAR(255) NOT NULL,
  "tokenHash" VARCHAR(128) NOT NULL,
  "configJson" JSONB,
  "desiredConfigVersion" INTEGER NOT NULL DEFAULT 1,
  "lastAppliedVersion" INTEGER,
  "lastSeenAt" TIMESTAMP(6),
  "status" "NodeAgentStatus" NOT NULL DEFAULT 'PENDING',
  "statusMessage" VARCHAR(1000),
  "lastLog" TEXT,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "node_agents_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "stores"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "node_agent_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "nodeId" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "ts" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "level" VARCHAR(32) NOT NULL,
  "message" VARCHAR(1000) NOT NULL,
  "metaJson" JSONB,
  CONSTRAINT "node_agent_events_nodeId_fkey" FOREIGN KEY ("nodeId") REFERENCES "node_agents"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "node_agents_storeId_slug_key" ON "node_agents"("storeId", "slug");
CREATE INDEX IF NOT EXISTS "node_agents_storeId_idx" ON "node_agents"("storeId");
CREATE INDEX IF NOT EXISTS "node_agents_lastSeenAt_idx" ON "node_agents"("lastSeenAt");
CREATE INDEX IF NOT EXISTS "node_agent_events_nodeId_ts_idx" ON "node_agent_events"("nodeId", "ts" DESC);
CREATE INDEX IF NOT EXISTS "node_agent_events_storeId_ts_idx" ON "node_agent_events"("storeId", "ts" DESC);
