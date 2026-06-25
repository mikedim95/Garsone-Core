CREATE TABLE IF NOT EXISTS "pending_node_agents" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "nodeKey" VARCHAR(128) NOT NULL UNIQUE,
  "pairingHash" VARCHAR(128) NOT NULL,
  "displayName" VARCHAR(255) NOT NULL,
  "localHostname" VARCHAR(255),
  "tailscaleHostname" VARCHAR(255),
  "macAddresses" JSONB,
  "ipAddresses" JSONB,
  "bootstrapJson" JSONB,
  "status" VARCHAR(32) NOT NULL DEFAULT 'PENDING',
  "storeId" UUID,
  "claimedNodeId" UUID,
  "lastSeenAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pending_node_agents_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "stores"("id")
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "pending_node_agents_claimedNodeId_fkey"
    FOREIGN KEY ("claimedNodeId") REFERENCES "node_agents"("id")
    ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "pending_node_agents_nodeKey_key"
  ON "pending_node_agents"("nodeKey");

CREATE INDEX IF NOT EXISTS "pending_node_agents_status_lastSeenAt_idx"
  ON "pending_node_agents"("status", "lastSeenAt" DESC);
