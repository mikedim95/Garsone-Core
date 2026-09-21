// @ts-ignore – Render's tsc sometimes can't resolve jsonwebtoken types
import jwt, { SignOptions, Secret } from "jsonwebtoken";

export function jwtSecret(): Secret {
  const secret = process.env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32 || secret === "your-secret-key") {
    throw new Error("JWT_SECRET must be an independent random secret of at least 32 bytes");
  }
  return secret;
}
const JWT_EXPIRES_IN = (process.env.JWT_EXPIRES_IN ||
  "7d") as SignOptions["expiresIn"];

export interface JWTPayload {
  userId: string;
  email: string;
  role: "waiter" | "manager" | "cook" | "architect" | "hybrid";
  storeId: string;
  storeSlug: string;
  cookTypeId?: string | null;
  waiterTypeId?: string | null;
  printerTopic?: string | null;
  cookTypePrinterTopic?: string | null;
  waiterTypePrinterTopic?: string | null;
}

export function signToken(payload: JWTPayload): string {
  const options: SignOptions = { expiresIn: JWT_EXPIRES_IN, algorithm: "HS256" };
  return jwt.sign(payload, jwtSecret(), options);
}

export function verifyToken(token: string): JWTPayload {
  const payload = jwt.verify(token, jwtSecret(), { algorithms: ["HS256"] });
  if (typeof payload === "string" || !payload.exp || !payload.iat ||
      typeof payload.userId !== "string" || typeof payload.storeId !== "string" ||
      typeof payload.storeSlug !== "string" ||
      !["waiter", "manager", "cook", "architect", "hybrid"].includes(payload.role)) {
    throw new Error("Invalid session claims");
  }
  return payload as JWTPayload;
}
