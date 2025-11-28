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

// Visit tokens disabled: QR links can work without a session token.
export const REQUIRE_TABLE_VISIT = false;

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

export async function validateTableVisitToken() {
  return null;
}
