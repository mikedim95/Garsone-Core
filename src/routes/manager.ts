import { FastifyInstance } from "fastify";
import { z } from "zod";
import bcrypt from "bcrypt";
import { db } from "../db/index.js";
import { authMiddleware, requireRole } from "../middleware/auth.js";
import { ensureStore } from "../lib/store.js";
import { publishMessage } from "../lib/mqtt.js";
import { invalidateMenuCache } from "./menu.js";
import { createHmac, createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const LOCAL_UPLOAD_ROOT = process.env.LOCAL_UPLOAD_DIR || path.join(process.cwd(), "uploads");

const guessMimeType = (filePath: string) => {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
};

const pickFirstEnv = (...values: Array<string | undefined>) =>
  values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim() || "";

const getR2Config = () => {
  const endpoint = pickFirstEnv(
    process.env.R2_S3_ENDPOINT,
    process.env.S3_ENDPOINT,
    process.env.AWS_ENDPOINT_URL_S3,
    process.env.AWS_S3_ENDPOINT,
    process.env.CLOUDFLARE_R2_ENDPOINT
  );
  const bucket = pickFirstEnv(
    process.env.R2_BUCKET,
    process.env.S3_BUCKET,
    process.env.AWS_S3_BUCKET,
    process.env.CLOUDFLARE_R2_BUCKET
  );
  const accessKeyId = pickFirstEnv(
    process.env.R2_ACCESS_KEY_ID,
    process.env.R2_ACCESS_KEY,
    process.env.AWS_ACCESS_KEY_ID,
    process.env.S3_ACCESS_KEY_ID
  );
  const secretAccessKey = pickFirstEnv(
    process.env.R2_SECRET_ACCESS_KEY,
    process.env.R2_SECRET_KEY,
    process.env.AWS_SECRET_ACCESS_KEY,
    process.env.S3_SECRET_ACCESS_KEY
  );
  return {
    endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
    publicBaseUrl: pickFirstEnv(
      process.env.R2_PUBLIC_BASE_URL,
      process.env.R2_PUBLIC_URL,
      process.env.CLOUDFLARE_R2_PUBLIC_URL
    ),
    region: process.env.R2_REGION || "auto",
  };
};

const signR2Request = (
  method: string,
  endpoint: string,
  bucket: string,
  key: string,
  body: Buffer,
  accessKeyId: string,
  secretAccessKey: string,
  region: string,
  extraHeaders: Record<string, string> = {}
) => {
  const normalizedEndpoint = endpoint.replace(/\/$/, "");
  const host = new URL(normalizedEndpoint).host;
  const encodedKey = key.split("/").map(encodeURIComponent).join("/");
  const path = `/${encodeURIComponent(bucket)}${encodedKey ? `/${encodedKey}` : ""}`;
  const now = new Date();
  const iso = now.toISOString();
  const amzDate = iso.replace(/[:-]/g, "").replace(/\.\d{3}Z$/, "Z");
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = createHash("sha256").update(body).digest("hex");
  const signedHeaderValues: Record<string, string> = {
    host,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
    ...extraHeaders,
  };
  const sortedHeaderNames = Object.keys(signedHeaderValues).sort();
  const canonicalHeaders = sortedHeaderNames
    .map((headerName) => `${headerName.toLowerCase()}:${signedHeaderValues[headerName]}\n`)
    .join("");
  const signedHeaders = sortedHeaderNames.map((headerName) => headerName.toLowerCase()).join(";");
  const canonicalRequest = [
    method,
    path,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const algorithm = "AWS4-HMAC-SHA256";
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const kDate = createHmac("sha256", Buffer.from(`AWS4${secretAccessKey}`)).update(dateStamp).digest();
  const kRegion = createHmac("sha256", kDate).update(region).digest();
  const kService = createHmac("sha256", kRegion).update("s3").digest();
  const kSigning = createHmac("sha256", kService).update("aws4_request").digest();
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  return {
    url: `${normalizedEndpoint}${path}`,
    headers: {
      ...signedHeaderValues,
      Authorization: `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
};

const deriveR2PublicBase = (imageUrl?: string | null, storeSlug?: string | null) => {
  const raw = String(imageUrl || "").trim();
  const slug = String(storeSlug || "").trim();
  if (!raw || !slug) return "";
  const marker = `/${slug}/`;
  const idx = raw.indexOf(marker);
  if (idx > 0) {
    return raw.slice(0, idx);
  }
  try {
    const parsed = new URL(raw);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "";
  }
};

export async function managerRoutes(fastify: FastifyInstance) {
  const managerOnly = [authMiddleware, requireRole(["manager", "architect"])];

  fastify.get("/uploads/*", async (request, reply) => {
    try {
      const raw = String((request.params as any)?.["*"] || "").trim();
      if (!raw) {
        return reply.status(404).send({ error: "File not found" });
      }
      const normalized = raw
        .split("/")
        .map((segment) => segment.trim())
        .filter(Boolean);
      if (!normalized.length || normalized.some((segment) => segment === "." || segment === "..")) {
        return reply.status(400).send({ error: "Invalid upload path" });
      }
      const filePath = path.join(LOCAL_UPLOAD_ROOT, ...normalized);
      const data = await fs.readFile(filePath);
      return reply.type(guessMimeType(filePath)).send(data);
    } catch {
      return reply.status(404).send({ error: "File not found" });
    }
  });

  fastify.get("/media/:bucket/*", async (request, reply) => {
    try {
      const params = request.params as any;
      const bucket = String(params?.bucket || "").trim();
      const key = String(params?.["*"] || "").trim();
      const normalized = key
        .split("/")
        .map((segment) => segment.trim())
        .filter(Boolean);
      if (
        !bucket ||
        !normalized.length ||
        normalized.some((segment) => segment === "." || segment === "..")
      ) {
        return reply.status(400).send({ error: "Invalid media path" });
      }

      const config = getR2Config();
      if (
        !config.endpoint ||
        !config.bucket ||
        !config.accessKeyId ||
        !config.secretAccessKey ||
        bucket !== config.bucket
      ) {
        return reply.status(404).send({ error: "Media not found" });
      }

      const requestedKey = normalized.join("/");
      const signed = signR2Request(
        "GET",
        config.endpoint,
        bucket,
        requestedKey,
        Buffer.alloc(0),
        config.accessKeyId,
        config.secretAccessKey,
        config.region
      );
      const res = await fetch(signed.url, {
        method: "GET",
        headers: signed.headers as any,
      } as any);
      if (!res.ok) {
        return reply.status(res.status === 404 ? 404 : 502).send({ error: "Media not found" });
      }

      const contentType = res.headers.get("content-type") || guessMimeType(requestedKey);
      const cacheControl = "public, max-age=31536000, immutable";
      const buffer = Buffer.from(await res.arrayBuffer());
      return reply.header("Cache-Control", cacheControl).type(contentType).send(buffer);
    } catch (error) {
      fastify.log.error(error, "R2 media fetch error");
      return reply.status(500).send({ error: "Media fetch failed" });
    }
  });

  // Image upload to R2 (S3 API) if configured, otherwise fallback to legacy storage.
  // Body: { fileName, mimeType, base64, itemId? }
  fastify.post(
    "/manager/uploads/image",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const store = await ensureStore(request);
        const body = request.body as any;
        const fileName = String(body?.fileName || "").trim();
        const mimeType = String(body?.mimeType || "application/octet-stream");
        const base64 = String(body?.base64 || "");
        const itemId = String(body?.itemId || "").trim();

        if (!fileName || !base64) {
          return reply.status(400).send({ error: "fileName and base64 are required" });
        }

        const sanitizeSegment = (s: string) =>
          String(s || "")
            .replace(/[\r\n\t]+/g, " ")
            .replace(/[\\/]+/g, "-")
            .replace(/\s{2,}/g, " ")
            .trim()
            .slice(0, 120);

        const slugSegment = (s: string) =>
          sanitizeSegment(s)
            .toLowerCase()
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-+|-+$/g, "");

        const buffer = Buffer.from(base64.replace(/^data:[^,]*,/, ""), "base64");
        const storeSlug = slugSegment(store.slug || "store") || "store";

        const existingStoreImage = await db.item.findFirst({
          where: {
            storeId: store.id,
            imageUrl: {
              not: null,
            },
          },
          select: { imageUrl: true },
          orderBy: { updatedAt: "desc" },
        });

        // R2 config (S3-compatible)
        const r2Config = getR2Config();
        const R2_ENDPOINT = r2Config.endpoint; // e.g. https://<accountid>.r2.cloudflarestorage.com
        const R2_BUCKET = r2Config.bucket;
        const R2_ACCESS = r2Config.accessKeyId;
        const R2_SECRET = r2Config.secretAccessKey;
        const R2_PUBLIC = pickFirstEnv(
          r2Config.publicBaseUrl,
          deriveR2PublicBase(existingStoreImage?.imageUrl, storeSlug)
        ); // e.g. https://pub-xxxx.r2.dev
        const R2_REGION = r2Config.region;
        const requireR2Uploads =
          String(process.env.REQUIRE_R2_UPLOADS || "").toLowerCase() === "true";

        const extFrom = (name: string, mt: string) => {
          const dot = name.lastIndexOf(".");
          if (dot > -1 && dot < name.length - 1) return name.slice(dot + 1).toLowerCase();
          if (mt === "image/jpeg") return "jpg";
          if (mt === "image/png") return "png";
          if (mt === "image/webp") return "webp";
          if (mt === "image/gif") return "gif";
          return "bin";
        };

        const buildKey = async () => {
          if (itemId) {
            const item = await db.item.findFirst({
              where: { id: itemId, storeId: store.id },
              include: { category: true },
            });
            if (item) {
              const itemTitle = slugSegment(item.titleEn || item.title || "Item");
              const ext = extFrom(fileName, mimeType);
              const objectName = `${itemTitle}.${ext}`;
              // Desired public URL example when bucket == store slug:
              //   https://pub-xxx.r2.dev/<storeSlug>/Menu/<Item>.jpg
              // If bucket equals store slug, omit the store slug from the key to avoid duplication.
              if (R2_BUCKET && slugSegment(R2_BUCKET) === storeSlug) {
                return `Menu/${objectName}`;
              }
              // Otherwise include store slug in the key under a shared bucket.
              return `${storeSlug}/Menu/${objectName}`;
            }
          }
          const safeName = `${Date.now()}-${slugSegment(fileName.replace(/\.[^.]+$/, "")) || "upload"}.${extFrom(fileName, mimeType)}`;
          return `${storeSlug}/${slugSegment("temp") || "temp"}/${safeName}`;
        };

        const tryR2 = async () => {
          if (!R2_ENDPOINT || !R2_BUCKET || !R2_ACCESS || !R2_SECRET || !R2_PUBLIC) return null as null | { publicUrl: string; path: string };

          const key = await buildKey();
          const endpoint = R2_ENDPOINT.replace(/\/$/, "");

          const signed = signR2Request(
            "PUT",
            endpoint,
            R2_BUCKET,
            key,
            buffer,
            R2_ACCESS,
            R2_SECRET,
            R2_REGION,
            { "Content-Type": mimeType }
          );

          const res = await fetch(signed.url, {
            method: "PUT",
            headers: signed.headers as any,
            body: buffer,
          } as any);

          if (!res.ok) {
            const txt = await res.text();
            fastify.log.error({ status: res.status, txt }, "R2 upload failed");
            return null;
          }

          const base = R2_PUBLIC.replace(/\/$/, "");
          const publicHost = (() => {
            try {
              return new URL(base).host;
            } catch {
              return "";
            }
          })();
          const isR2DevPublicHost = /\.r2\.dev$/i.test(publicHost);
          const pathSegments = key.split("/").map(encodeURIComponent).join("/");
          const needsBucket =
            !isR2DevPublicHost &&
            !base.endsWith(`/${R2_BUCKET}`) &&
            !base.includes(`/${R2_BUCKET}/`);
          const publicUrl = `${base}${needsBucket ? `/${encodeURIComponent(R2_BUCKET)}` : ""}/${pathSegments}`;
          return { publicUrl, path: key };
        };

        const r2Result = await tryR2();
        if (r2Result) {
          return reply.send(r2Result);
        }
        if (requireR2Uploads) {
          const missing = [
            ["R2_S3_ENDPOINT", R2_ENDPOINT],
            ["R2_BUCKET", R2_BUCKET],
            ["R2_ACCESS_KEY_ID", R2_ACCESS],
            ["R2_SECRET_ACCESS_KEY", R2_SECRET],
            ["R2_PUBLIC_BASE_URL", R2_PUBLIC],
          ]
            .filter(([, value]) => !value)
            .map(([name]) => name);
          const detail = missing.length
            ? `Missing R2 config: ${missing.join(", ")}`
            : "R2 upload failed";
          fastify.log.error({ missing }, "R2 upload required but unavailable");
          return reply.status(500).send({ error: detail });
        }

        const SUPA_URL = process.env.SUPABASE_URL;
        const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
        const BUCKET = process.env.SUPABASE_BUCKET || "assets";
        if (SUPA_URL && SUPA_KEY) {
          const safeName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9_\.\-]/g, "-")}`;
          const supaPath = `${storeSlug}/${itemId || "temp"}/${safeName}`;
          const supaUrl = `${SUPA_URL.replace(/\/$/, "")}/storage/v1/object/${BUCKET}/${supaPath}`;

          const supaRes = await fetch(supaUrl, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${SUPA_KEY}`,
              "Content-Type": mimeType,
              "x-upsert": "true",
            } as any,
            body: buffer,
          } as any);

          if (!supaRes.ok) {
            const txt = await supaRes.text();
            fastify.log.error({ status: supaRes.status, txt }, "Supabase upload failed");
          } else {
            const publicUrl = `${SUPA_URL.replace(/\/$/, "")}/storage/v1/object/public/${BUCKET}/${supaPath}`;
            return reply.send({ publicUrl, path: supaPath });
          }
        }

        const localKey = await buildKey();
        const localFilePath = path.join(
          LOCAL_UPLOAD_ROOT,
          ...localKey.split("/").filter(Boolean)
        );
        await fs.mkdir(path.dirname(localFilePath), { recursive: true });
        await fs.writeFile(localFilePath, buffer);
        const proto = String(
          (request.headers["x-forwarded-proto"] as string) ||
            (request.protocol as string) ||
            "https"
        )
          .split(",")[0]
          .trim();
        const host = String(
          (request.headers["x-forwarded-host"] as string) ||
            (request.headers.host as string) ||
            ""
        )
          .split(",")[0]
          .trim();
        if (host) {
          const publicUrl = `${proto}://${host}/uploads/${localKey
            .split("/")
            .map(encodeURIComponent)
            .join("/")}`;
          return reply.send({ publicUrl, path: localKey });
        }
        return reply.status(500).send({ error: "Upload failed: storage not configured" });
      } catch (e: any) {
        fastify.log.error(e, "Manager image upload error");
        return reply.status(500).send({ error: "Upload failed" });
      }
    }
  );

  const serializeManagerTable = (table: any) => ({
    id: table.id,
    label: table.label,
    isActive: table.isActive,
    waiterCount: table._count?.waiterTables ?? 0,
    orderCount: table._count?.orders ?? 0,
  });

  const getTableWithCounts = async (storeId: string, tableId: string) => {
    return db.table.findFirst({
      where: { id: tableId, storeId },
      include: {
        _count: {
          select: {
            waiterTables: true,
            orders: true,
          },
        },
      },
    });
  };

  const tableCreateSchema = z.object({
    label: z.string().trim().min(1).max(50),
    isActive: z.boolean().optional(),
  });

  const tableUpdateSchema = z
    .object({
      label: z.string().trim().min(1).max(50).optional(),
      isActive: z.boolean().optional(),
    })
    .refine(
      (data) =>
        typeof data.label !== "undefined" ||
        typeof data.isActive !== "undefined",
      {
        message: "No fields to update provided",
        path: ["label"],
      }
    );

  // Tables CRUD
  fastify.get(
    "/manager/tables",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const store = await ensureStore(request);
        const tables = await db.table.findMany({
          where: { storeId: store.id },
          orderBy: { label: "asc" },
          include: {
            _count: {
              select: {
                waiterTables: true,
                orders: true,
              },
            },
          },
        });
        return reply.send({ tables: tables.map(serializeManagerTable) });
      } catch (e) {
        console.error("Failed to list tables", e);
        return reply.status(500).send({ error: "Failed to list tables" });
      }
    }
  );

  fastify.post(
    "/manager/tables",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const body = tableCreateSchema.parse(request.body);
        const store = await ensureStore(request);
        const label = body.label.trim();

        const existing = await db.table.findFirst({
          where: { storeId: store.id, label },
        });
        if (existing) {
          return reply
            .status(409)
            .send({ error: "Table label already exists" });
        }

        const created = await db.table.create({
          data: {
            storeId: store.id,
            label,
            isActive: body.isActive ?? true,
          },
        });

        const withCounts = await getTableWithCounts(store.id, created.id);
        if (!withCounts) {
          return reply
            .status(500)
            .send({ error: "Failed to load created table" });
        }
        return reply
          .status(201)
          .send({ table: serializeManagerTable(withCounts) });
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply
            .status(400)
            .send({ error: "Invalid request", details: e.errors });
        }
        console.error("Failed to create table", e);
        return reply.status(500).send({ error: "Failed to create table" });
      }
    }
  );

  fastify.patch(
    "/manager/tables/:id",
    { preHandler: managerOnly },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const body = tableUpdateSchema.parse(request.body);
        const store = await ensureStore(request);

        const table = await db.table.findFirst({
          where: { id, storeId: store.id },
        });
        if (!table) {
          return reply.status(404).send({ error: "Table not found" });
        }

        const updateData: { label?: string; isActive?: boolean } = {};
        if (typeof body.label !== "undefined") {
          const label = body.label.trim();
          if (label !== table.label) {
            const duplicate = await db.table.findFirst({
              where: { storeId: store.id, label },
            });
            if (duplicate) {
              return reply
                .status(409)
                .send({ error: "Another table already uses that label" });
            }
          }
          updateData.label = label;
        }
        if (typeof body.isActive !== "undefined") {
          updateData.isActive = body.isActive;
        }

        await db.table.update({
          where: { id },
          data: updateData,
        });

        const withCounts = await getTableWithCounts(store.id, id);
        if (!withCounts) {
          return reply
            .status(500)
            .send({ error: "Failed to load updated table" });
        }
        return reply.send({ table: serializeManagerTable(withCounts) });
      } catch (e) {
        if (e instanceof z.ZodError) {
          return reply
            .status(400)
            .send({ error: "Invalid request", details: e.errors });
        }
        console.error("Failed to update table", e);
        return reply.status(500).send({ error: "Failed to update table" });
      }
    }
  );

  fastify.delete(
    "/manager/tables/:id",
    { preHandler: managerOnly },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const store = await ensureStore(request);

        const table = await db.table.findFirst({
          where: { id, storeId: store.id },
        });
        if (!table) {
          return reply.status(404).send({ error: "Table not found" });
        }

        await db.waiterTable.deleteMany({
          where: { storeId: store.id, tableId: id },
        });

        await db.table.update({
          where: { id },
          data: { isActive: false },
        });

        const withCounts = await getTableWithCounts(store.id, id);
        if (!withCounts) {
          return reply.status(500).send({ error: "Failed to load table" });
        }
        return reply.send({ table: serializeManagerTable(withCounts) });
      } catch (e) {
        console.error("Failed to deactivate table", e);
        return reply.status(500).send({ error: "Failed to delete table" });
      }
    }
  );

  const normalizeSlug = (value: string) => {
    const raw = (value || "").trim().toLowerCase();
    if (!raw) return "";
    return raw
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 100);
  };

  const normalizePrinterTopic = (value?: string | null) => {
    const raw = (value || "").trim().toLowerCase();
    if (!raw) return null;
    const sanitized = raw
      .replace(/[^a-z0-9:_-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 255);
    return sanitized || null;
  };

  const getStorePrinters = (store: { settingsJson?: any }) => {
    const raw = (store as any)?.settingsJson?.printers;
    if (!Array.isArray(raw)) return [] as string[];
    return raw
      .map((printer) =>
        normalizePrinterTopic(typeof printer === "string" ? printer : null)
      )
      .filter((printer): printer is string => Boolean(printer));
  };

  const ensurePrinterTopicAllowed = (
    store: { settingsJson?: any },
    value?: string | null
  ) => {
    const normalized = normalizePrinterTopic(value);
    if (!normalized) return null;
    const storePrinters = getStorePrinters(store);
    if (storePrinters.length === 0) {
      throw new Error("No printers configured for this store");
    }
    if (!storePrinters.includes(normalized)) {
      throw new Error("Printer topic must match a configured printer");
    }
    return normalized;
  };

  // Cook types CRUD
  fastify.get(
    "/manager/cook-types",
    { preHandler: managerOnly },
    async (request, reply) => {
      const store = await ensureStore(request);
      const types = await db.cookType.findMany({
        where: { storeId: store.id },
        orderBy: { title: "asc" },
      });
      return reply.send({ types });
    }
  );

  const cookTypeCreate = z.object({
    title: z.string().min(1),
    printerTopic: z.string().trim().min(1).max(255).optional(),
  });
  fastify.post(
    "/manager/cook-types",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const body = cookTypeCreate.parse(request.body);
        const store = await ensureStore(request);
        const slugBase = normalizeSlug(body.title);
        const slug =
          slugBase || `cook-${Math.random().toString(16).slice(2, 6)}`;
        let printerTopic: string | null = null;
        try {
          printerTopic = ensurePrinterTopicAllowed(store, body.printerTopic);
        } catch (error: any) {
          return reply
            .status(400)
            .send({ error: error?.message || "Invalid printer topic" });
        }
        const created = await db.cookType.create({
          data: { storeId: store.id, slug, title: body.title, printerTopic },
        });
        return reply.status(201).send({ type: created });
      } catch (e) {
        if (e instanceof z.ZodError)
          return reply
            .status(400)
            .send({ error: "Invalid request", details: e.errors });
        return reply.status(500).send({ error: "Failed to create cook type" });
      }
    }
  );

  const cookTypeUpdate = z.object({
    title: z.string().min(1).optional(),
    printerTopic: z.string().trim().min(1).max(255).nullable().optional(),
  });
  fastify.patch(
    "/manager/cook-types/:id",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = cookTypeUpdate.parse(request.body);
        const store = await ensureStore(request);
        const data: any = {};
        if (body.title) data.title = body.title;
        if (body.printerTopic !== undefined) {
          if (body.printerTopic === null) {
            data.printerTopic = null;
          } else {
            try {
              data.printerTopic = ensurePrinterTopicAllowed(
                store,
                body.printerTopic
              );
            } catch (error: any) {
              return reply
                .status(400)
                .send({ error: error?.message || "Invalid printer topic" });
            }
          }
        }
        const updated = await db.cookType.update({ where: { id }, data });
        return reply.send({ type: updated });
      } catch (e) {
        if (e instanceof z.ZodError)
          return reply
            .status(400)
            .send({ error: "Invalid request", details: e.errors });
        return reply.status(500).send({ error: "Failed to update cook type" });
      }
    }
  );

  fastify.delete(
    "/manager/cook-types/:id",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        await db.cookType.delete({ where: { id } });
        return reply.send({ success: true });
      } catch {
        return reply.status(500).send({ error: "Failed to delete cook type" });
      }
    }
  );

  // Waiter types CRUD
  fastify.get(
    "/manager/waiter-types",
    { preHandler: managerOnly },
    async (request, reply) => {
      const store = await ensureStore(request);
      const types = await db.waiterType.findMany({
        where: { storeId: store.id },
        orderBy: { title: "asc" },
      });
      return reply.send({ types });
    }
  );

  const waiterTypeCreate = z.object({
    title: z.string().min(1),
    printerTopic: z.string().trim().min(1).max(255).optional(),
  });
  fastify.post(
    "/manager/waiter-types",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const body = waiterTypeCreate.parse(request.body);
        const store = await ensureStore(request);
        const slugBase = normalizeSlug(body.title);
        const slug =
          slugBase || `waiter-${Math.random().toString(16).slice(2, 6)}`;
        let printerTopic: string | null = null;
        try {
          printerTopic = ensurePrinterTopicAllowed(store, body.printerTopic);
        } catch (error: any) {
          return reply
            .status(400)
            .send({ error: error?.message || "Invalid printer topic" });
        }
        const created = await db.waiterType.create({
          data: { storeId: store.id, slug, title: body.title, printerTopic },
        });
        return reply.status(201).send({ type: created });
      } catch (e) {
        if (e instanceof z.ZodError)
          return reply
            .status(400)
            .send({ error: "Invalid request", details: e.errors });
        return reply
          .status(500)
          .send({ error: "Failed to create waiter type" });
      }
    }
  );

  const waiterTypeUpdate = z.object({
    title: z.string().min(1).optional(),
    printerTopic: z.string().trim().min(1).max(255).nullable().optional(),
  });
  fastify.patch(
    "/manager/waiter-types/:id",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = waiterTypeUpdate.parse(request.body);
        const store = await ensureStore(request);
        const data: any = {};
        if (body.title) data.title = body.title;
        if (body.printerTopic !== undefined) {
          if (body.printerTopic === null) {
            data.printerTopic = null;
          } else {
            try {
              data.printerTopic = ensurePrinterTopicAllowed(
                store,
                body.printerTopic
              );
            } catch (error: any) {
              return reply
                .status(400)
                .send({ error: error?.message || "Invalid printer topic" });
            }
          }
        }
        const updated = await db.waiterType.update({ where: { id }, data });
        return reply.send({ type: updated });
      } catch (e) {
        if (e instanceof z.ZodError)
          return reply
            .status(400)
            .send({ error: "Invalid request", details: e.errors });
        return reply
          .status(500)
          .send({ error: "Failed to update waiter type" });
      }
    }
  );

  fastify.delete(
    "/manager/waiter-types/:id",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        await db.waiterType.delete({ where: { id } });
        return reply.send({ success: true });
      } catch {
        return reply.status(500).send({ error: "Failed to delete waiter type" });
      }
    }
  );

  // Waiters CRUD
  fastify.get(
    "/manager/waiters",
    { preHandler: managerOnly },
    async (request, reply) => {
      const store = await ensureStore(request);
      const waiters = await db.profile.findMany({
        where: { storeId: store.id, role: "WAITER" },
        orderBy: { displayName: "asc" },
        include: { waiterType: true },
      });
      return reply.send({
        waiters: waiters.map((w) => ({
          id: w.id,
          email: w.email,
          displayName: w.displayName,
          waiterTypeId: w.waiterTypeId,
          waiterType: w.waiterType
            ? {
                id: w.waiterType.id,
                slug: w.waiterType.slug,
                title: w.waiterType.title,
                printerTopic: w.waiterType.printerTopic,
              }
            : null,
        })),
      });
    }
  );

  const waiterCreateSchema = z.object({
    email: z.string().email(),
    password: z.string().min(6),
    displayName: z.string().min(1),
    waiterTypeId: z.string().uuid().optional(),
  });
  fastify.post(
    "/manager/waiters",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const body = waiterCreateSchema.parse(request.body);
        const store = await ensureStore(request);
        const waiterType = body.waiterTypeId
          ? await db.waiterType.findFirst({
              where: { id: body.waiterTypeId, storeId: store.id },
            })
          : null;
        if (body.waiterTypeId && !waiterType) {
          return reply.status(404).send({ error: "Waiter type not found" });
        }
        const passwordHash = await bcrypt.hash(body.password, 10);
        const waiter = await db.profile.create({
          data: {
            storeId: store.id,
            email: body.email.toLowerCase(),
            passwordHash,
            role: "WAITER",
            displayName: body.displayName,
            waiterTypeId: waiterType?.id ?? null,
          },
          include: { waiterType: true },
        });
        return reply.status(201).send({
          waiter: {
            id: waiter.id,
            email: waiter.email,
            displayName: waiter.displayName,
            waiterTypeId: waiter.waiterTypeId,
            waiterType: waiter.waiterType
              ? {
                  id: waiter.waiterType.id,
                  slug: waiter.waiterType.slug,
                  title: waiter.waiterType.title,
                  printerTopic: waiter.waiterType.printerTopic,
                }
              : null,
          },
        });
      } catch (e) {
        if (e instanceof z.ZodError)
          return reply
            .status(400)
            .send({ error: "Invalid request", details: e.errors });
        return reply.status(500).send({ error: "Failed to create waiter" });
      }
    }
  );

  const waiterUpdateSchema = z.object({
    email: z.string().email().optional(),
    password: z.string().min(6).optional(),
    displayName: z.string().min(1).optional(),
    waiterTypeId: z.string().uuid().nullable().optional(),
  });
  fastify.patch(
    "/manager/waiters/:id",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = waiterUpdateSchema.parse(request.body);
        const store = await ensureStore(request);
        const data: any = {};
        if (body.email) data.email = body.email.toLowerCase();
        if (body.displayName) data.displayName = body.displayName;
        if (body.password)
          data.passwordHash = await bcrypt.hash(body.password, 10);
        if (body.waiterTypeId !== undefined) {
          if (body.waiterTypeId === null) {
            data.waiterTypeId = null;
          } else {
            const waiterType = await db.waiterType.findFirst({
              where: { id: body.waiterTypeId, storeId: store.id },
            });
            if (!waiterType) {
              return reply
                .status(404)
                .send({ error: "Waiter type not found" });
            }
            data.waiterTypeId = waiterType.id;
          }
        }
        const updated = await db.profile.update({
          where: { id },
          data,
          include: { waiterType: true },
        });
        return reply.send({
          waiter: {
            id: updated.id,
            email: updated.email,
            displayName: updated.displayName,
            waiterTypeId: updated.waiterTypeId,
            waiterType: updated.waiterType
              ? {
                  id: updated.waiterType.id,
                  slug: updated.waiterType.slug,
                  title: updated.waiterType.title,
                  printerTopic: updated.waiterType.printerTopic,
                }
              : null,
          },
        });
      } catch (e) {
        if (e instanceof z.ZodError)
          return reply
            .status(400)
            .send({ error: "Invalid request", details: e.errors });
        return reply.status(500).send({ error: "Failed to update waiter" });
      }
    }
  );

  fastify.delete(
    "/manager/waiters/:id",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        await db.profile.delete({ where: { id } });
        return reply.send({ success: true });
      } catch {
        return reply.status(500).send({ error: "Failed to delete waiter" });
      }
    }
  );

  // Cooks CRUD
  fastify.get(
    "/manager/cooks",
    { preHandler: managerOnly },
    async (request, reply) => {
      const store = await ensureStore(request);
      const cooks = await db.profile.findMany({
        where: { storeId: store.id, role: "COOK" },
        orderBy: { displayName: "asc" },
        include: { cookType: true },
      });
      return reply.send({
        cooks: cooks.map((c) => ({
          id: c.id,
          email: c.email,
          displayName: c.displayName,
          cookTypeId: c.cookTypeId,
          cookType: c.cookType
            ? {
                id: c.cookType.id,
                slug: c.cookType.slug,
                title: c.cookType.title,
                printerTopic: c.cookType.printerTopic,
              }
            : null,
        })),
      });
    }
  );

  const cookCreateSchema = z.object({
    email: z.string().email(),
    password: z.string().min(6),
    displayName: z.string().min(1),
    cookTypeId: z.string().uuid().optional(),
  });
  fastify.post(
    "/manager/cooks",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const body = cookCreateSchema.parse(request.body);
        const store = await ensureStore(request);
        const cookType = body.cookTypeId
          ? await db.cookType.findFirst({
              where: { id: body.cookTypeId, storeId: store.id },
            })
          : null;
        if (body.cookTypeId && !cookType) {
          return reply.status(404).send({ error: "Cook type not found" });
        }
        const passwordHash = await bcrypt.hash(body.password, 10);
        const cook = await db.profile.create({
          data: {
            storeId: store.id,
            email: body.email.toLowerCase(),
            passwordHash,
            role: "COOK",
            displayName: body.displayName,
            cookTypeId: cookType?.id ?? null,
          },
          include: { cookType: true },
        });
        return reply.status(201).send({
          cook: {
            id: cook.id,
            email: cook.email,
            displayName: cook.displayName,
            cookTypeId: cook.cookTypeId,
            cookType: cook.cookType
              ? {
                  id: cook.cookType.id,
                  slug: cook.cookType.slug,
                  title: cook.cookType.title,
                  printerTopic: cook.cookType.printerTopic,
                }
              : null,
          },
        });
      } catch (e) {
        if (e instanceof z.ZodError)
          return reply
            .status(400)
            .send({ error: "Invalid request", details: e.errors });
        return reply.status(500).send({ error: "Failed to create cook" });
      }
    }
  );

  const cookUpdateSchema = z.object({
    email: z.string().email().optional(),
    password: z.string().min(6).optional(),
    displayName: z.string().min(1).optional(),
    cookTypeId: z.string().uuid().nullable().optional(),
  });
  fastify.patch(
    "/manager/cooks/:id",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = cookUpdateSchema.parse(request.body);
        const store = await ensureStore(request);
        const data: any = {};
        if (body.email) data.email = body.email.toLowerCase();
        if (body.displayName) data.displayName = body.displayName;
        if (body.password)
          data.passwordHash = await bcrypt.hash(body.password, 10);
        if (body.cookTypeId !== undefined) {
          if (body.cookTypeId === null) {
            data.cookTypeId = null;
          } else {
            const cookType = await db.cookType.findFirst({
              where: { id: body.cookTypeId, storeId: store.id },
            });
            if (!cookType) {
              return reply
                .status(404)
                .send({ error: "Cook type not found" });
            }
            data.cookTypeId = cookType.id;
          }
        }
        const updated = await db.profile.update({
          where: { id },
          data,
          include: { cookType: true },
        });
        return reply.send({
          cook: {
            id: updated.id,
            email: updated.email,
            displayName: updated.displayName,
            cookTypeId: updated.cookTypeId,
            cookType: updated.cookType
              ? {
                  id: updated.cookType.id,
                  slug: updated.cookType.slug,
                  title: updated.cookType.title,
                  printerTopic: updated.cookType.printerTopic,
                }
              : null,
          },
        });
      } catch (e) {
        if (e instanceof z.ZodError)
          return reply
            .status(400)
            .send({ error: "Invalid request", details: e.errors });
        return reply.status(500).send({ error: "Failed to update cook" });
      }
    }
  );

  fastify.delete(
    "/manager/cooks/:id",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        await db.profile.delete({ where: { id } });
        return reply.send({ success: true });
      } catch {
        return reply.status(500).send({ error: "Failed to delete cook" });
      }
    }
  );

  // Items CRUD
  fastify.get(
    "/manager/items",
    { preHandler: managerOnly },
    async (request, reply) => {
      const store = await ensureStore(request);
      const items = await db.item.findMany({
        where: { storeId: store.id },
        orderBy: { sortOrder: "asc" },
        include: { category: true },
      });
      return reply.send({
        items: items.map((i) => ({
          id: i.id,
          title: i.title,
          titleEn: i.titleEn || i.title,
          titleEl: i.titleEl || i.title,
          subcategory: i.subcategoryEn ?? i.subcategoryEl ?? null,
          subcategoryEn: i.subcategoryEn ?? null,
          subcategoryEl: i.subcategoryEl ?? null,
          description: i.description,
          descriptionEn: i.descriptionEn ?? i.description,
          descriptionEl: i.descriptionEl ?? i.description,
          imageUrl: i.imageUrl,
          priceCents: i.priceCents,
          isAvailable: i.isAvailable,
          categoryId: i.categoryId,
          category:
            i.category?.titleEn ?? i.category?.titleEl ?? i.category?.title,
          printerTopic: i.printerTopic ?? null,
        })),
      });
    }
  );

  const normalizeOptionalItemText = (value?: string | null) => {
    if (value == null) return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  const itemCreateSchema = z.object({
    titleEn: z.string().min(1),
    titleEl: z.string().min(1),
    subcategoryEn: z.string().trim().max(255).nullable().optional(),
    subcategoryEl: z.string().trim().max(255).nullable().optional(),
    descriptionEn: z.string().optional(),
    descriptionEl: z.string().optional(),
    imageUrl: z.string().url().max(2048).optional(),
    printerTopic: z.string().trim().min(1).max(255),
    priceCents: z.number().int().nonnegative(),
    categoryId: z.string().uuid(),
    isAvailable: z.boolean().optional(),
  });
  fastify.post(
    "/manager/items",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const body = itemCreateSchema.parse(request.body);
        const store = await ensureStore(request);
        const slugBase = body.titleEn
          .toLowerCase()
          .replace(/\s+/g, "-")
          .slice(0, 60);
        let printerTopic: string | null = null;
        try {
          printerTopic = ensurePrinterTopicAllowed(store, body.printerTopic);
        } catch (error: any) {
          return reply
            .status(400)
            .send({ error: error?.message || "Invalid printer topic" });
        }
        if (!printerTopic) {
          return reply.status(400).send({ error: "Printer topic is required" });
        }
        const item = await db.item.create({
          data: {
            storeId: store.id,
            categoryId: body.categoryId,
            slug: `${slugBase}-${Math.random().toString(16).slice(2, 6)}`,
            title: body.titleEn,
            titleEn: body.titleEn,
            titleEl: body.titleEl,
            subcategoryEn: normalizeOptionalItemText(body.subcategoryEn),
            subcategoryEl: normalizeOptionalItemText(body.subcategoryEl),
            description: body.descriptionEn,
            descriptionEn: body.descriptionEn,
            descriptionEl: body.descriptionEl,
            imageUrl: body.imageUrl,
            printerTopic,
            priceCents: body.priceCents,
            isAvailable: body.isAvailable ?? true,
          },
        });
        invalidateMenuCache();
        publishMessage(
          `stores/${store.slug}/menu/updated`,
          {
            type: "item.created",
            itemId: item.id,
            ts: new Date().toISOString(),
          },
          { roles: ["manager"] }
        );
        return reply.status(201).send({ item });
      } catch (e) {
        if (e instanceof z.ZodError)
          return reply
            .status(400)
            .send({ error: "Invalid request", details: e.errors });
        return reply.status(500).send({ error: "Failed to create item" });
      }
    }
  );

  const itemUpdateSchema = z.object({
    title: z.string().min(1).optional(),
    titleEn: z.string().min(1).optional(),
    titleEl: z.string().min(1).optional(),
    subcategoryEn: z.string().trim().max(255).nullable().optional(),
    subcategoryEl: z.string().trim().max(255).nullable().optional(),
    description: z.string().optional(),
    descriptionEn: z.string().optional().nullable(),
    descriptionEl: z.string().optional().nullable(),
    imageUrl: z.string().url().max(2048).nullable().optional(),
    printerTopic: z.string().trim().min(1).max(255).nullable().optional(),
    priceCents: z.number().int().nonnegative().optional(),
    categoryId: z.string().uuid().optional(),
    isAvailable: z.boolean().optional(),
  });
  fastify.patch(
    "/manager/items/:id",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = itemUpdateSchema.parse(request.body);
        const store = await ensureStore(request);
        const data: any = { ...body };
        if (body.printerTopic !== undefined) {
          if (body.printerTopic === null) {
            data.printerTopic = null;
          } else {
            try {
              data.printerTopic = ensurePrinterTopicAllowed(
                store,
                body.printerTopic
              );
            } catch (error: any) {
              return reply
                .status(400)
                .send({ error: error?.message || "Invalid printer topic" });
            }
          }
        }
        if (body.titleEn) {
          data.title = body.titleEn;
        } else if (body.title) {
          data.title = body.title;
          data.titleEn = body.title;
        }
        if (body.subcategoryEn !== undefined) {
          data.subcategoryEn = normalizeOptionalItemText(body.subcategoryEn);
        }
        if (body.subcategoryEl !== undefined) {
          data.subcategoryEl = normalizeOptionalItemText(body.subcategoryEl);
        }
        const updated = await db.item.update({ where: { id }, data });
        invalidateMenuCache();
        publishMessage(
          `stores/${store.slug}/menu/updated`,
          {
            type: "item.updated",
            itemId: updated.id,
            ts: new Date().toISOString(),
          },
          { roles: ["manager"] }
        );
        return reply.send({ item: updated });
      } catch (e) {
        if (e instanceof z.ZodError)
          return reply
            .status(400)
            .send({ error: "Invalid request", details: e.errors });
        return reply.status(500).send({ error: "Failed to update item" });
      }
    }
  );

  fastify.delete(
    "/manager/items/:id",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        // Guard: prevent deleting if there are orderItems referencing this item
        const orderItemCount = await db.orderItem.count({
          where: { itemId: id },
        });
        if (orderItemCount > 0) {
          return reply.status(400).send({
            error: "Cannot delete item: it is referenced by existing orders",
          });
        }
        // Remove any item-modifier links first
        await db.itemModifier.deleteMany({ where: { itemId: id } });
        await db.item.delete({ where: { id } });
        invalidateMenuCache();
        const store = await ensureStore(request);
        publishMessage(
          `stores/${store.slug}/menu/updated`,
          { type: "item.deleted", itemId: id, ts: new Date().toISOString() },
          { roles: ["manager"] }
        );
        return reply.send({ success: true });
      } catch (e) {
        console.error("Delete item error:", e);
        return reply.status(500).send({ error: "Failed to delete item" });
      }
    }
  );

  fastify.get(
    "/manager/items/:id/detail",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const item = await db.item.findUnique({ where: { id } });
        if (!item) return reply.status(404).send({ error: "Not found" });
        const links = await db.itemModifier.findMany({ where: { itemId: id } });
        const modifiers = await db.modifier.findMany({
          where: { id: { in: links.map((l) => l.modifierId) } },
          include: { modifierOptions: { orderBy: { sortOrder: "asc" } } },
          orderBy: { title: "asc" },
        });
        return reply.send({
          item,
          modifiers,
          links: links.map((l) => ({
            modifierId: l.modifierId,
            isRequired: l.isRequired,
          })),
        });
      } catch (e) {
        return reply.status(500).send({ error: "Failed to load item detail" });
      }
    }
  );

  // Modifiers CRUD
  fastify.get(
    "/manager/modifiers",
    { preHandler: managerOnly },
    async (request, reply) => {
      const store = await ensureStore(request);
      const modifiers = await db.modifier.findMany({
        where: { storeId: store.id },
        orderBy: { title: "asc" },
        include: { modifierOptions: { orderBy: { sortOrder: "asc" } } },
      });
      return reply.send({ modifiers });
    }
  );

  const modifierCreateSchema = z.object({
    titleEn: z.string().min(1),
    titleEl: z.string().min(1),
    minSelect: z.number().int().min(0).default(0),
    maxSelect: z.number().int().min(0).nullable().optional(),
    isAvailable: z.boolean().optional(),
  });
  fastify.post(
    "/manager/modifiers",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const body = modifierCreateSchema.parse(request.body);
        const store = await ensureStore(request);
        const slug = `${body.titleEn
          .toLowerCase()
          .replace(/\s+/g, "-")
          .slice(0, 60)}-${Math.random().toString(16).slice(2, 6)}`;
        const modifier = await db.modifier.create({
          data: {
            storeId: store.id,
            slug,
            title: body.titleEn,
            titleEn: body.titleEn,
            titleEl: body.titleEl,
            minSelect: body.minSelect,
            maxSelect:
              typeof body.maxSelect === "number" ? body.maxSelect : undefined,
            isAvailable: body.isAvailable ?? true,
          },
        });
        invalidateMenuCache();
        publishMessage(
          `stores/${store.slug}/menu/updated`,
          {
            type: "modifier.created",
            modifierId: modifier.id,
            ts: new Date().toISOString(),
          },
          { roles: ["manager"] }
        );
        return reply.status(201).send({ modifier });
      } catch (e) {
        if (e instanceof z.ZodError)
          return reply
            .status(400)
            .send({ error: "Invalid request", details: e.errors });
        return reply.status(500).send({ error: "Failed to create modifier" });
      }
    }
  );

  const modifierUpdateSchema = z.object({
    title: z.string().min(1).optional(),
    titleEn: z.string().min(1).optional(),
    titleEl: z.string().min(1).optional(),
    minSelect: z.number().int().min(0).optional(),
    maxSelect: z.number().int().min(0).nullable().optional(),
    isAvailable: z.boolean().optional(),
  });
  fastify.patch(
    "/manager/modifiers/:id",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = modifierUpdateSchema.parse(request.body);
        const data: any = { ...body };
        if (body.titleEn) {
          data.title = body.titleEn;
        } else if (body.title) {
          data.title = body.title;
          data.titleEn = body.title;
        }
        if (typeof body.maxSelect !== "number") {
          delete data.maxSelect;
        }
        const updated = await db.modifier.update({ where: { id }, data });
        invalidateMenuCache();
        const store = await ensureStore(request);
        publishMessage(
          `stores/${store.slug}/menu/updated`,
          {
            type: "modifier.updated",
            modifierId: updated.id,
            ts: new Date().toISOString(),
          },
          { roles: ["manager"] }
        );
        return reply.send({ modifier: updated });
      } catch (e) {
        if (e instanceof z.ZodError)
          return reply
            .status(400)
            .send({ error: "Invalid request", details: e.errors });
        return reply.status(500).send({ error: "Failed to update modifier" });
      }
    }
  );

  fastify.delete(
    "/manager/modifiers/:id",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        await db.modifier.delete({ where: { id } });
        return reply.send({ success: true });
      } catch {
        return reply.status(500).send({ error: "Failed to delete modifier" });
      }
    }
  );

  // Modifier Option create/update/delete
  const optionCreateSchema = z.object({
    modifierId: z.string().uuid(),
    titleEn: z.string().min(1),
    titleEl: z.string().min(1),
    priceDeltaCents: z.number().int().nullable().optional().default(0),
    sortOrder: z.number().int().nullable().optional().default(0),
  });
  fastify.post(
    "/manager/modifier-options",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const body = optionCreateSchema.parse(request.body);
        const store = await ensureStore(request);
        const opt = await db.modifierOption.create({
          data: {
            storeId: store.id,
            modifierId: body.modifierId,
            slug: `${body.titleEn
              .toLowerCase()
              .replace(/\s+/g, "-")
              .slice(0, 60)}-${Math.random().toString(16).slice(2, 6)}`,
            title: body.titleEn,
            titleEn: body.titleEn,
            titleEl: body.titleEl,
            priceDeltaCents: body.priceDeltaCents ?? 0,
            sortOrder: body.sortOrder ?? 0,
          },
        });
        return reply.status(201).send({ option: opt });
      } catch (e) {
        if (e instanceof z.ZodError)
          return reply
            .status(400)
            .send({ error: "Invalid request", details: e.errors });
        return reply
          .status(500)
          .send({ error: "Failed to create modifier option" });
      }
    }
  );

  const optionUpdateSchema = z.object({
    title: z.string().min(1).optional(),
    titleEn: z.string().min(1).optional(),
    titleEl: z.string().min(1).optional(),
    priceDeltaCents: z.number().int().nullable().optional(),
    sortOrder: z.number().int().nullable().optional(),
  });
  fastify.patch(
    "/manager/modifier-options/:id",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = optionUpdateSchema.parse(request.body);
        const data: any = { ...body };
        if (body.titleEn) {
          data.title = body.titleEn;
        } else if (body.title) {
          data.title = body.title;
          data.titleEn = body.title;
        }
        const updated = await db.modifierOption.update({
          where: { id },
          data: {
            ...data,
            priceDeltaCents:
              typeof data.priceDeltaCents === "number"
                ? data.priceDeltaCents
                : undefined,
            sortOrder:
              typeof data.sortOrder === "number" ? data.sortOrder : undefined,
          },
        });
        return reply.send({ option: updated });
      } catch (e) {
        if (e instanceof z.ZodError)
          return reply
            .status(400)
            .send({ error: "Invalid request", details: e.errors });
        return reply
          .status(500)
          .send({ error: "Failed to update modifier option" });
      }
    }
  );

  fastify.delete(
    "/manager/modifier-options/:id",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        await db.modifierOption.delete({ where: { id } });
        return reply.send({ success: true });
      } catch {
        return reply
          .status(500)
          .send({ error: "Failed to delete modifier option" });
      }
    }
  );

  // Item-Modifier linking
  const linkSchema = z.object({
    itemId: z.string().uuid(),
    modifierId: z.string().uuid(),
    isRequired: z.boolean().default(false),
  });
  fastify.post(
    "/manager/item-modifiers",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const body = linkSchema.parse(request.body);
        const store = await ensureStore(request);
        const link = await db.itemModifier.upsert({
          where: {
            itemId_modifierId: {
              itemId: body.itemId,
              modifierId: body.modifierId,
            },
          },
          update: { isRequired: body.isRequired },
          create: {
            storeId: store.id,
            itemId: body.itemId,
            modifierId: body.modifierId,
            isRequired: body.isRequired,
          },
        });
        return reply.status(201).send({ link });
      } catch (e) {
        if (e instanceof z.ZodError)
          return reply
            .status(400)
            .send({ error: "Invalid request", details: e.errors });
        return reply.status(500).send({ error: "Failed to link modifier" });
      }
    }
  );

  fastify.delete(
    "/manager/item-modifiers",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const body = linkSchema.parse(request.body);
        await db.itemModifier.delete({
          where: {
            itemId_modifierId: {
              itemId: body.itemId,
              modifierId: body.modifierId,
            },
          },
        });
        return reply.send({ success: true });
      } catch (e) {
        if (e instanceof z.ZodError)
          return reply
            .status(400)
            .send({ error: "Invalid request", details: e.errors });
        return reply.status(500).send({ error: "Failed to unlink modifier" });
      }
    }
  );

  // Orders admin (delete or cancel)
  fastify.delete(
    "/manager/orders/:id",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        await db.order.delete({ where: { id } });
        return reply.send({ success: true });
      } catch (e) {
        return reply.status(500).send({ error: "Failed to delete order" });
      }
    }
  );

  fastify.patch(
    "/manager/orders/:id/cancel",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const updated = await db.order.update({
          where: { id },
          data: { status: "CANCELLED" },
        });
        return reply.send({
          order: { id: updated.id, status: updated.status },
        });
      } catch (e) {
        return reply.status(500).send({ error: "Failed to cancel order" });
      }
    }
  );

  // Categories CRUD
  fastify.get(
    "/manager/categories",
    { preHandler: managerOnly },
    async (request, reply) => {
      const store = await ensureStore(request);
      const categories = await db.category.findMany({
        where: { storeId: store.id },
        orderBy: { sortOrder: "asc" },
      });
      return reply.send({ categories });
    }
  );

  const categoryCreate = z.object({
    titleEn: z.string().min(1),
    titleEl: z.string().min(1),
    sortOrder: z.number().int().optional(),
    printerTopic: z.string().trim().min(1).max(255).optional(),
  });
  fastify.post(
    "/manager/categories",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const body = categoryCreate.parse(request.body);
        const store = await ensureStore(request);
        const slug = (
          body.titleEn.toLowerCase().replace(/\s+/g, "-") +
          "-" +
          Math.random().toString(16).slice(2, 6)
        ).slice(0, 100);
        const printerTopic =
          normalizePrinterTopic(body.printerTopic) ??
          normalizePrinterTopic(body.titleEn) ??
          normalizePrinterTopic(slug) ??
          slug;
        const cat = await db.category.create({
          data: {
            storeId: store.id,
            title: body.titleEn,
            titleEn: body.titleEn,
            titleEl: body.titleEl,
            slug,
            sortOrder: body.sortOrder ?? 0,
            printerTopic,
          },
        });
        return reply.status(201).send({ category: cat });
      } catch (e) {
        if (e instanceof z.ZodError)
          return reply
            .status(400)
            .send({ error: "Invalid request", details: e.errors });
        return reply.status(500).send({ error: "Failed to create category" });
      }
    }
  );

  const categoryUpdate = z.object({
    title: z.string().min(1).optional(),
    titleEn: z.string().min(1).optional(),
    titleEl: z.string().min(1).optional(),
    sortOrder: z.number().int().optional(),
    printerTopic: z.string().trim().min(1).max(255).nullable().optional(),
  });
  fastify.patch(
    "/manager/categories/:id",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const body = categoryUpdate.parse(request.body);
        const normalizedPrinterTopic =
          body.printerTopic === undefined
            ? undefined
            : normalizePrinterTopic(body.printerTopic);
        const data: any = { ...body };
        if (body.titleEn) {
          data.title = body.titleEn;
        } else if (body.title) {
          data.title = body.title;
          data.titleEn = body.title;
          data.titleEl = body.title;
        }
        if (normalizedPrinterTopic !== undefined) {
          data.printerTopic = normalizedPrinterTopic;
        }
        const updated = await db.category.update({ where: { id }, data });
        return reply.send({ category: updated });
      } catch (e) {
        if (e instanceof z.ZodError)
          return reply
            .status(400)
            .send({ error: "Invalid request", details: e.errors });
        return reply.status(500).send({ error: "Failed to update category" });
      }
    }
  );

  fastify.delete(
    "/manager/categories/:id",
    { preHandler: managerOnly },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        await db.category.delete({ where: { id } });
        return reply.send({ success: true });
      } catch (e) {
        return reply.status(500).send({ error: "Failed to delete category" });
      }
    }
  );
}
