import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export const DEFAULT_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";

export const buildEtag = (payload: unknown): string => {
  const json = typeof payload === "string" ? payload : JSON.stringify(payload ?? "");
  const hash = crypto.createHash("sha1").update(json).digest("hex");
  return `W/"${hash}"`;
};

export const toHttpDate = (value: number | Date) =>
  new Date(value).toUTCString();

export const isNotModified = (
  request: FastifyRequest,
  etag?: string,
  lastModified?: number | Date
): boolean => {
  const ifNoneMatch = request.headers["if-none-match"];
  const ifModifiedSince = request.headers["if-modified-since"];

  if (etag && ifNoneMatch && ifNoneMatch === etag) {
    return true;
  }

  if (lastModified && ifModifiedSince) {
    const since = Date.parse(ifModifiedSince);
    if (!Number.isNaN(since) && since >= new Date(lastModified).getTime()) {
      return true;
    }
  }
  return false;
};

export const applyCacheHeaders = (
  reply: FastifyReply,
  etag?: string,
  lastModified?: number | Date,
  cacheControl: string = DEFAULT_CACHE_CONTROL
) => {
  reply.header("Cache-Control", cacheControl);
  if (etag) {
    reply.header("ETag", etag);
  }
  if (lastModified) {
    reply.header("Last-Modified", toHttpDate(lastModified));
  }
};
