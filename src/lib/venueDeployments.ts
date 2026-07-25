import { db } from "../db/index.js";

export type DeploymentChannel = "STABLE" | "STAGE";
export type DeploymentComponent = "CORE" | "FRONT";

const DEFAULT_NAMESPACE = "mikedim95";

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function int(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : fallback;
}

export function fallbackImageRef(
  component: DeploymentComponent,
  channel: DeploymentChannel,
  namespace = DEFAULT_NAMESPACE
) {
  const image = component === "CORE" ? "garsone-core" : "garsone-front";
  const tag = channel === "STAGE" ? "stage" : "pi";
  return `${namespace}/${image}:${tag}`;
}

export function legacyDeploymentFromStore(store: any) {
  const settings = asObject(store?.settingsJson);
  const deployment = asObject(settings.venueDeployment);
  const namespace = String(deployment.imageNamespace || DEFAULT_NAMESPACE);
  const tag = String(deployment.imageTag || "pi");
  const channel: DeploymentChannel =
    String(deployment.channel || "").toUpperCase() === "STAGE" ||
    tag.toLowerCase() === "stage"
      ? "STAGE"
      : "STABLE";
  const target: "PI" | "ONLINE" =
    deployment.target === "PI" ? "PI" : "ONLINE";
  const desiredState: "RUNNING" | "STOPPED" =
    deployment.desiredState === "RUNNING" ? "RUNNING" : "STOPPED";
  return {
    id: null,
    nodeId: null,
    target,
    desiredState,
    autoUpdate:
      typeof deployment.autoUpdate === "boolean"
        ? deployment.autoUpdate
        : target === "PI",
    channel,
    version: int(deployment.version, 0),
    appliedVersion: int(deployment.appliedVersion, 0),
    dataSyncVersion: int(
      deployment.dataSyncVersion,
      target === "PI" ? 1 : 0
    ),
    appliedDataSyncVersion: int(
      deployment.appliedDataSyncVersion,
      target === "PI" ? 1 : 0
    ),
    frontendPort: int(deployment.frontendPort, 8080),
    corePort: int(deployment.corePort, 8787),
    desiredCoreImageRef:
      String(deployment.desiredCoreImageRef || "").trim() ||
      `${namespace}/garsone-core:${tag}`,
    desiredFrontImageRef:
      String(deployment.desiredFrontImageRef || "").trim() ||
      `${namespace}/garsone-front:${tag}`,
    appliedCoreImageRef: String(deployment.appliedCoreImageRef || "").trim(),
    appliedFrontImageRef: String(deployment.appliedFrontImageRef || "").trim(),
    status: String(deployment.status || "ONLINE_ONLY"),
    message: String(deployment.message || ""),
    localUrl: String(deployment.localUrl || ""),
    apiUrl: String(deployment.apiUrl || ""),
    requestedAt: iso(deployment.requestedAt),
    lastReportedAt: iso(deployment.lastReportedAt),
    lastBackupAt: iso(deployment.lastBackupAt),
    lastBackupFile: String(deployment.lastBackupFile || ""),
    services: asObject(deployment.services),
    imageNamespace: namespace,
    imageTag: tag,
  };
}

export function serializeVenueDeployment(row: any, store?: any) {
  if (!row) return legacyDeploymentFromStore(store);
  const channel: DeploymentChannel = row.channel === "STAGE" ? "STAGE" : "STABLE";
  return {
    id: row.id,
    nodeId: row.nodeId || null,
    target: row.target === "PI" ? "PI" : "ONLINE",
    desiredState: row.desiredState === "RUNNING" ? "RUNNING" : "STOPPED",
    autoUpdate: Boolean(row.autoUpdate),
    channel,
    version: int(row.version, 0),
    appliedVersion: int(row.appliedVersion, 0),
    dataSyncVersion: int(row.dataSyncVersion, 0),
    appliedDataSyncVersion: int(row.appliedDataSyncVersion, 0),
    frontendPort: int(row.frontendPort, 8080),
    corePort: int(row.corePort, 8787),
    desiredCoreImageRef:
      String(row.desiredCoreImageRef || "").trim() ||
      fallbackImageRef("CORE", channel),
    desiredFrontImageRef:
      String(row.desiredFrontImageRef || "").trim() ||
      fallbackImageRef("FRONT", channel),
    appliedCoreImageRef: String(row.appliedCoreImageRef || "").trim(),
    appliedFrontImageRef: String(row.appliedFrontImageRef || "").trim(),
    status: String(row.status || "ONLINE_ONLY"),
    message: String(row.message || ""),
    localUrl: String(row.localUrl || ""),
    apiUrl: String(row.apiUrl || ""),
    requestedAt: iso(row.requestedAt),
    lastReportedAt: iso(row.lastReportedAt),
    lastBackupAt: iso(row.lastBackupAt),
    lastBackupFile: String(row.lastBackupFile || ""),
    services: asObject(row.servicesJson),
    imageNamespace: DEFAULT_NAMESPACE,
    imageTag: channel === "STAGE" ? "stage" : "pi",
  };
}

export async function getVenueDeployment(store: any) {
  const row = await db.venueDeployment.findUnique({
    where: { storeId: store.id },
  });
  return serializeVenueDeployment(row, store);
}

export async function latestRelease(
  channel: DeploymentChannel,
  component: DeploymentComponent
) {
  return db.piRelease.findFirst({
    where: { channel, component },
    orderBy: [{ publishedAt: "desc" }, { createdAt: "desc" }],
  });
}

export async function ensureVenueDeployment(store: any, node: any | null) {
  const legacy = legacyDeploymentFromStore(store);
  const channel = legacy.channel as DeploymentChannel;
  const [coreRelease, frontRelease] = await Promise.all([
    latestRelease(channel, "CORE"),
    latestRelease(channel, "FRONT"),
  ]);
  return db.venueDeployment.upsert({
    where: { storeId: store.id },
    update: node ? { nodeId: node.id } : {},
    create: {
      storeId: store.id,
      nodeId: node?.id || null,
      target: legacy.target,
      desiredState: legacy.desiredState,
      autoUpdate: legacy.autoUpdate,
      channel,
      version: legacy.version,
      appliedVersion: legacy.appliedVersion,
      dataSyncVersion: legacy.dataSyncVersion,
      appliedDataSyncVersion: legacy.appliedDataSyncVersion,
      frontendPort: legacy.frontendPort,
      corePort: legacy.corePort,
      desiredCoreReleaseId: coreRelease?.id || null,
      desiredFrontReleaseId: frontRelease?.id || null,
      desiredCoreImageRef:
        coreRelease?.imageRef || legacy.desiredCoreImageRef,
      desiredFrontImageRef:
        frontRelease?.imageRef || legacy.desiredFrontImageRef,
      appliedCoreImageRef: legacy.appliedCoreImageRef || null,
      appliedFrontImageRef: legacy.appliedFrontImageRef || null,
      status: legacy.status,
      message: legacy.message || null,
      localUrl: legacy.localUrl || null,
      apiUrl: legacy.apiUrl || null,
      servicesJson: legacy.services,
      requestedAt: legacy.requestedAt
        ? new Date(legacy.requestedAt)
        : null,
      lastReportedAt: legacy.lastReportedAt
        ? new Date(legacy.lastReportedAt)
        : null,
      lastBackupAt: legacy.lastBackupAt
        ? new Date(legacy.lastBackupAt)
        : null,
      lastBackupFile: legacy.lastBackupFile || null,
    },
  });
}

export function deploymentForLegacySettings(deployment: any) {
  const serialized = serializeVenueDeployment(deployment);
  return {
    ...serialized,
    services: serialized.services || {},
  };
}
