import webPush, { type PushSubscription } from "web-push";
import { Prisma } from "@prisma/client";
import { db } from "../db/index.js";

type StaffPushSubscriptionRow = {
  id: string;
  profileId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
};

const vapidPublicKey = (process.env.VAPID_PUBLIC_KEY || "").trim();
const vapidPrivateKey = (process.env.VAPID_PRIVATE_KEY || "").trim();
const vapidSubject =
  (process.env.VAPID_SUBJECT || "").trim() || "mailto:support@garsone.app";

const pushEnabled = Boolean(vapidPublicKey && vapidPrivateKey);

if (pushEnabled) {
  webPush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
}

export function getStaffPushConfig() {
  return {
    enabled: pushEnabled,
    publicKey: pushEnabled ? vapidPublicKey : null,
  };
}

export async function ensureStaffPushSchema() {
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "staff_push_subscriptions" (
      "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      "storeId" UUID NOT NULL REFERENCES "stores"("id") ON DELETE CASCADE,
      "profileId" UUID NOT NULL REFERENCES "profiles"("id") ON DELETE CASCADE,
      "role" VARCHAR(32) NOT NULL,
      "printerTopic" VARCHAR(255),
      "endpoint" VARCHAR(1000) NOT NULL UNIQUE,
      "p256dh" VARCHAR(255) NOT NULL,
      "auth" VARCHAR(255) NOT NULL,
      "userAgent" VARCHAR(500),
      "createdAt" TIMESTAMP(6) NOT NULL DEFAULT now(),
      "updatedAt" TIMESTAMP(6) NOT NULL DEFAULT now()
    )
  `);
  await db.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "staff_push_subscriptions_store_profile_idx"
      ON "staff_push_subscriptions"("storeId", "profileId")
  `);
  await db.$executeRawUnsafe(`
    CREATE INDEX IF NOT EXISTS "staff_push_subscriptions_store_role_topic_idx"
      ON "staff_push_subscriptions"("storeId", "role", "printerTopic")
  `);
}

export async function upsertStaffPushSubscription(params: {
  storeId: string;
  profileId: string;
  role: string;
  printerTopic?: string | null;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}) {
  await ensureStaffPushSchema();
  await db.$executeRaw`
    INSERT INTO "staff_push_subscriptions"
      ("storeId", "profileId", "role", "printerTopic", "endpoint", "p256dh", "auth", "userAgent")
    VALUES
      (
        ${params.storeId}::uuid,
        ${params.profileId}::uuid,
        ${params.role},
        ${params.printerTopic ?? null},
        ${params.endpoint},
        ${params.p256dh},
        ${params.auth},
        ${params.userAgent ?? null}
      )
    ON CONFLICT ("endpoint") DO UPDATE SET
      "storeId" = EXCLUDED."storeId",
      "profileId" = EXCLUDED."profileId",
      "role" = EXCLUDED."role",
      "printerTopic" = EXCLUDED."printerTopic",
      "p256dh" = EXCLUDED."p256dh",
      "auth" = EXCLUDED."auth",
      "userAgent" = EXCLUDED."userAgent",
      "updatedAt" = now()
  `;
}

export async function removeStaffPushEndpoint(endpoint: string) {
  if (!endpoint) return;
  await db.$executeRaw`
    DELETE FROM "staff_push_subscriptions"
    WHERE "endpoint" = ${endpoint}
  `;
}

export async function notifyStaffPush(params: {
  storeId: string;
  profileIds?: string[];
  roles?: string[];
  printerTopics?: string[];
  title: string;
  body: string;
  tag: string;
  url: string;
}) {
  if (!pushEnabled) return;
  await ensureStaffPushSchema();

  const filters: Prisma.Sql[] = [Prisma.sql`"storeId"::text = ${params.storeId}`];
  if (params.profileIds?.length) {
    filters.push(Prisma.sql`"profileId"::text IN (${Prisma.join(params.profileIds)})`);
  }
  if (params.roles?.length) {
    filters.push(Prisma.sql`"role" IN (${Prisma.join(params.roles)})`);
  }
  if (params.printerTopics?.length) {
    filters.push(Prisma.sql`"printerTopic" IN (${Prisma.join(params.printerTopics)})`);
  }

  const subscriptions = await db.$queryRaw<StaffPushSubscriptionRow[]>(Prisma.sql`
    SELECT "id", "profileId", "endpoint", "p256dh", "auth"
    FROM "staff_push_subscriptions"
    WHERE ${Prisma.join(filters, " AND ")}
  `);

  if (subscriptions.length === 0) return;

  const payload = JSON.stringify({
    title: params.title,
    body: params.body,
    tag: params.tag,
    url: params.url,
  });

  await Promise.all(
    subscriptions.map(async (subscription) => {
      const pushSubscription: PushSubscription = {
        endpoint: subscription.endpoint,
        keys: {
          p256dh: subscription.p256dh,
          auth: subscription.auth,
        },
      };

      try {
        await webPush.sendNotification(pushSubscription, payload, {
          TTL: 10 * 60,
          urgency: "high",
        });
      } catch (error) {
        const statusCode = (error as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await removeStaffPushEndpoint(subscription.endpoint);
          return;
        }
        console.warn("[staff-push] failed to send notification", {
          profileId: subscription.profileId,
          statusCode,
          error,
        });
      }
    })
  );
}
