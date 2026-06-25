import webPush, { type PushSubscription } from "web-push";
import { OrderStatus } from "@prisma/client";
import { db } from "../db/index.js";

type CustomerPushOrder = {
  id: string;
  storeId: string;
  tableId: string;
  status: OrderStatus;
  ticketNumber?: number | null;
  cancelReason?: string | null;
  table?: { label?: string | null } | null;
};

const vapidPublicKey = (process.env.VAPID_PUBLIC_KEY || "").trim();
const vapidPrivateKey = (process.env.VAPID_PRIVATE_KEY || "").trim();
const vapidSubject =
  (process.env.VAPID_SUBJECT || "").trim() || "mailto:support@garsone.app";
const tableFallbackSubscriptionTtlMs = Math.max(
  15 * 60 * 1000,
  Number.parseInt(
    process.env.CUSTOMER_PUSH_TABLE_SUBSCRIPTION_TTL_MS || "",
    10
  ) || 30 * 60 * 1000
);

const pushEnabled = Boolean(vapidPublicKey && vapidPrivateKey);

if (pushEnabled) {
  webPush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
} else {
  console.warn(
    "[customer-push] VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not set; customer push notifications are disabled."
  );
}

const statusCopy: Record<OrderStatus, { title: string; body: string }> = {
  [OrderStatus.PLACED]: {
    title: "Order submitted",
    body: "We received your order.",
  },
  [OrderStatus.PREPARING]: {
    title: "Order update",
    body: "Your order is being prepared.",
  },
  [OrderStatus.READY]: {
    title: "Order ready",
    body: "Your order is ready.",
  },
  [OrderStatus.SERVED]: {
    title: "Order served",
    body: "Your order has been served.",
  },
  [OrderStatus.PAID]: {
    title: "Order paid",
    body: "Your order is paid.",
  },
  [OrderStatus.CANCELLED]: {
    title: "Order cancelled",
    body: "Your order was cancelled.",
  },
};

export function getCustomerPushConfig() {
  return {
    enabled: pushEnabled,
    publicKey: pushEnabled ? vapidPublicKey : null,
  };
}

export async function removeCustomerPushEndpoint(endpoint: string) {
  if (!endpoint) return;
  await db.customerPushSubscription.deleteMany({ where: { endpoint } });
}

export async function notifyCustomerOrderStatus(params: {
  order: CustomerPushOrder;
  storeSlug: string;
}) {
  if (!pushEnabled || params.order.status === OrderStatus.PLACED) {
    return;
  }

  const { order, storeSlug } = params;
  const tableFallbackSince = new Date(
    Date.now() - tableFallbackSubscriptionTtlMs
  );
  const subscriptions = await db.customerPushSubscription.findMany({
    where: {
      storeId: order.storeId,
      OR: [
        { orderId: order.id },
        {
          tableId: order.tableId,
          orderId: null,
          updatedAt: { gte: tableFallbackSince },
        },
      ],
    },
  });

  if (subscriptions.length === 0) {
    return;
  }

  const copy = statusCopy[order.status];
  const tableLabel = order.table?.label ? `Table ${order.table.label}` : null;
  const ticketLabel = order.ticketNumber ? `#${order.ticketNumber}` : null;
  const context = [ticketLabel, tableLabel].filter(Boolean).join(" - ");
  const body =
    order.status === OrderStatus.CANCELLED && order.cancelReason
      ? `${copy.body} ${order.cancelReason}`
      : copy.body;
  const urlParams = new URLSearchParams({
    tableId: order.tableId,
    storeSlug,
    fromPush: "1",
  });
  const payload = JSON.stringify({
    title: copy.title,
    body: context ? `${body} (${context})` : body,
    orderId: order.id,
    tableId: order.tableId,
    status: order.status,
    tag: `order-${order.id}-${order.status}`,
    url: `/order/${order.id}/thanks?${urlParams.toString()}`,
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
          TTL: 60 * 60,
          urgency: order.status === OrderStatus.READY ? "high" : "normal",
        });
      } catch (error) {
        const statusCode = (error as { statusCode?: number })?.statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await removeCustomerPushEndpoint(subscription.endpoint);
          return;
        }
        console.warn("[customer-push] failed to send notification", {
          endpoint: subscription.endpoint,
          statusCode,
          error,
        });
      }
    })
  );
}
