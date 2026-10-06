import { z } from "zod";
import { db } from "../db/index.js";
import { normalizeQrUrl } from "./qrEvents.js";

const localStackSchema = z.object({
  schemaVersion: z.literal(1),
  storeSlug: z.string().min(1).max(100).regex(/^[a-z0-9][a-z0-9_-]*$/),
  localUrl: z.string().max(1000).transform((value, context) => {
    try { return normalizeQrUrl(value, true); }
    catch { context.addIssue({ code: z.ZodIssueCode.custom, message: "Use a bare HTTP or HTTPS local origin" }); return z.NEVER; }
  }),
  frontendPort: z.number().int().min(1).max(65535),
  corePort: z.number().int().min(1).max(65535),
}).strict().refine(value => {
  try {
    const url = new URL(value.localUrl);
    return Number(url.port || (url.protocol === "https:" ? 443 : 80)) === value.frontendPort;
  } catch { return false; }
}, "Local URL must use the declared frontend port");

export function localStackFromBootstrap(bootstrap: any) {
  // Legacy printer nodes (including old COMPOSE registrations without the new
  // metadata) retain their existing claim behavior.
  if (bootstrap?.deploymentMode !== "COMPOSE" || bootstrap.localStack === undefined) return null;
  return localStackSchema.parse(bootstrap.localStack);
}

export async function adoptLocalStack(store: any, node: any, localStack: z.infer<typeof localStackSchema> | null) {
  if (!localStack) return { status: "not_applicable" as const };
  return db.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "stores" WHERE "id" = ${store.id}::uuid FOR UPDATE`;
    const currentStore = await tx.store.findUniqueOrThrow({ where: { id: store.id }, select: { settingsJson: true } });
    const settings: any = currentStore.settingsJson || {};
    const existing = await tx.venueDeployment.findUnique({ where: { storeId: store.id }, include: { _count: { select: { events: true } } } });
    const legacy = settings.venueDeployment;
    const pristine = !existing || (existing.nodeId === null && existing.target === "ONLINE" && existing.desiredState === "STOPPED" &&
      existing.version === 0 && existing.appliedVersion === 0 && existing.dataSyncVersion === 0 && existing.appliedDataSyncVersion === 0 &&
      existing.requestedAt === null && existing.lastReportedAt === null && existing.status === "ONLINE_ONLY" && existing.message === null && existing._count.events === 0);
    if ((legacy && typeof legacy === "object" && Object.keys(legacy).length > 0) || !pristine) {
      return { status: "preserved" as const, reason: existing?.nodeId && existing.nodeId !== node.id ? "EXISTING_NODE" : "EXISTING_DEPLOYMENT",
        message: "The venue already has a deployment choice. It was preserved; review Venue Deployment before using this Pi for the venue." };
    }
    const data = {
      nodeId: node.id, target: "PI" as const, desiredState: "RUNNING" as const, autoUpdate: false,
      frontendPort: localStack.frontendPort, corePort: localStack.corePort,
      localUrl: localStack.localUrl, apiUrl: `${localStack.localUrl}/api`,
      status: "PENDING", message: "Existing local stack claimed; waiting for its health report",
    };
    let deployment;
    if (existing) {
      // A read of the Architect tab creates a default row. Adopt only that
      // untouched row, with an optimistic guard against a concurrent command.
      const updated = await tx.venueDeployment.updateMany({ where: {
        id: existing.id, nodeId: null, target: "ONLINE", desiredState: "STOPPED", version: 0, appliedVersion: 0,
        dataSyncVersion: 0, appliedDataSyncVersion: 0, requestedAt: null, lastReportedAt: null, status: "ONLINE_ONLY", message: null,
      }, data });
      if (!updated.count) return { status: "preserved" as const, reason: "EXISTING_DEPLOYMENT", message: "The venue deployment changed during claim and was preserved. Review Venue Deployment." };
      deployment = await tx.venueDeployment.findUniqueOrThrow({ where: { id: existing.id } });
    } else {
      deployment = await tx.venueDeployment.create({ data: { storeId: store.id, ...data } });
    }
    // This records an existing installation. No deployment, data-sync version,
    // image rollout or import is requested from the Pi.
    await tx.venueDeploymentEvent.create({ data: {
      deploymentId: deployment.id, storeId: store.id, nodeId: node.id, version: deployment.version,
      eventType: "ADOPT_LOCAL_STACK", status: deployment.status, message: deployment.message,
      metaJson: { localUrl: localStack.localUrl, frontendPort: localStack.frontendPort, corePort: localStack.corePort },
    } });
    return { status: "adopted" as const, localUrl: localStack.localUrl, nodeId: node.id };
  });
}
