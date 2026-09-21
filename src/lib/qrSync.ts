import { readFile } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { importQrEventBundle, normalizeQrUrl, qrEventBundleSchema } from "./qrEvents.js";

const connectionSchema = z.object({
  eventId: z.string().uuid(),
  cloudApiUrl: z.string().max(2000).transform(value => normalizeQrUrl(value))
    .refine(value => new URL(value).protocol === "https:", "Cloud sync requires HTTPS"),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict();

export const qrSyncConfigSchema = z.union([connectionSchema, z.array(connectionSchema).min(1).max(32)])
  .transform(value => Array.isArray(value) ? value : [value])
  .refine(value => new Set(value.map(entry => entry.eventId)).size === value.length, "Duplicate event connection");

async function boundedJson(response: Response) {
  if (!response.ok || response.redirected) throw new Error(`QR_SYNC_HTTP_${response.status}`);
  if (!response.headers.get("content-type")?.includes("application/json")) throw new Error("QR_SYNC_EXPECTED_JSON");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("QR_SYNC_EMPTY_BODY");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512 * 1024) throw new Error("QR_SYNC_BODY_TOO_LARGE");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function syncQrConnection(
  input: unknown,
  storeSlug: string,
  dependencies = { fetch, importBundle: importQrEventBundle },
) {
  const connection = connectionSchema.parse(input);
  const endpoint = `${connection.cloudApiUrl}/qr-sync/events/${connection.eventId}`;
  const headers = { Authorization: `Bearer ${connection.token}`, Accept: "application/json" };
  const result = await boundedJson(await dependencies.fetch(endpoint, {
    headers, redirect: "error", signal: AbortSignal.timeout(10_000),
  }));
  const bundle = qrEventBundleSchema.parse(result?.bundle);
  if (bundle.event.id !== connection.eventId || bundle.event.storeSlug !== storeSlug) {
    throw new Error("QR_SYNC_EVENT_OR_STORE_MISMATCH");
  }
  // Persist first. Losing connectivity at any point leaves the last applied local data intact.
  await dependencies.importBundle(bundle);
  await boundedJson(await dependencies.fetch(`${endpoint}/ack`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ appliedRevision: bundle.event.revision }),
    redirect: "error", signal: AbortSignal.timeout(10_000),
  }));
  return { eventId: connection.eventId, appliedRevision: bundle.event.revision };
}

export async function startQrSync(app: FastifyInstance) {
  if (process.env.QR_SYNC_ENABLED !== "true") return;
  if (process.env.LOCAL_ONLY !== "true" || !process.env.STORE_SLUG || !process.env.QR_SYNC_CONFIG_FILE) {
    throw new Error("QR sync requires LOCAL_ONLY=true, STORE_SLUG and a private QR_SYNC_CONFIG_FILE");
  }
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cycle = async () => {
    try {
      const raw = await readFile(process.env.QR_SYNC_CONFIG_FILE!, "utf8");
      if (Buffer.byteLength(raw) > 128 * 1024) throw new Error("QR_SYNC_CONFIG_TOO_LARGE");
      const connections = qrSyncConfigSchema.parse(JSON.parse(raw));
      for (const connection of connections) {
        if (stopped) break;
        try {
          const applied = await syncQrConnection(connection, process.env.STORE_SLUG!);
          app.log.info(applied, "QR event synchronization completed");
        } catch {
          // Do not log fetch errors/configuration: these can contain bearer tokens or URLs.
          app.log.warn({ eventId: connection.eventId }, "QR sync unavailable or rejected; keeping local event revision");
        }
      }
    } catch {
      app.log.warn("QR sync configuration unavailable or invalid; keeping local event revisions");
    } finally {
      if (!stopped) { timer = setTimeout(cycle, 60_000); timer.unref(); }
    }
  };
  app.addHook("onClose", async () => { stopped = true; if (timer) clearTimeout(timer); });
  void cycle();
}
