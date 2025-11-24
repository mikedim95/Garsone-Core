import crypto from "crypto";
import { TableVisitStatus } from "@prisma/client";
import { db } from "../db/index.js";

// Default to 4h. Override with TABLE_VISIT_TTL_MINUTES if needed.
const VISIT_TTL_MINUTES = (() => {
  const raw = process.env.TABLE_VISIT_TTL_MINUTES;
  const parsed = raw ? Number.parseInt(raw, 10) : 240;
  if (!Number.isFinite(parsed) || parsed <= 0) return 240;
  return parsed;
})();

export const REQUIRE_TABLE_VISIT =
  (process.env.REQUIRE_TABLE_VISIT || "1").toString().trim() !== "0";

const VISIT_TTL_MS = VISIT_TTL_MINUTES * 60_000;

function generateSessionToken() {
  return crypto.randomBytes(24).toString("hex"); // 48 chars, URL safe
}

export async function createTableVisitSession(input: {
  tileId: string;
  tableId: string;
  storeId: string;
}) {
  const expiresAt = new Date(Date.now() + VISIT_TTL_MS);
  const sessionToken = generateSessionToken();

  const visit = await db.tableVisit.create({
    data: {
      tileId: input.tileId,
      tableId: input.tableId,
      storeId: input.storeId,
      sessionToken,
      expiresAt,
      status: TableVisitStatus.OPEN,
    },
  });

  return visit;
}

export async function validateTableVisitToken(input: {
  sessionToken?: string | null;
  tableId: string;
  storeId: string;
}) {
  const token = (input.sessionToken || "").trim();
  if (!token) return null;

  const now = new Date();
  const visit = await db.tableVisit.findFirst({
    where: {
      sessionToken: token,
      tableId: input.tableId,
      storeId: input.storeId,
      status: TableVisitStatus.OPEN,
      expiresAt: { gt: now },
    },
  });

  return visit;
}
