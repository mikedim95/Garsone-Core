/**
 * Viva Payments Smart Checkout Integration
 * Uses Viva's official Smart Checkout API for sandbox/demo environment
 * 
 * Setup Instructions:
 * 1. Create account at https://demo.vivapayments.com
 * 2. Create a payment source to get sourceCode
 * 3. Set environment variables:
 *    - VIVA_API_KEY: Your API key from demo account
 *    - VIVA_SOURCE_CODE: Your payment source code (4 digits)
 * 4. Test with cards from: https://developer.viva.com/getting-started/test-cards
 */

const VIVA_DEMO_API_URL = "https://demo-api.vivapayments.com";
const VIVA_DEMO_CHECKOUT_URL = "https://demo.vivapayments.com/web/checkout";

// Get these from environment variables
const VIVA_API_KEY = process.env.VIVA_API_KEY || "";
const VIVA_SOURCE_CODE = process.env.VIVA_SOURCE_CODE || "Default";

export interface VivaPaymentRequest {
  amount: number;
  orderId: string;
  tableId: string;
  description: string;
  customerEmail?: string;
  customerName?: string;
}

export interface VivaPaymentSession {
  checkoutUrl: string;
  orderCode: string;
  amount: number;
}

export interface VivaCreateOrderResponse {
  orderCode: number | string;
}

export interface VivaWebhookPayload {
  transactionId: string;
  orderCode: string | number;
  amount: number;
  statusId: string;
  timeStamp: string;
}

/**
 * Create a payment order with Viva Smart Checkout API
 * This must be called from the backend with proper authentication
 * 
 * Viva Documentation: https://developer.viva.com/smart-checkout/smart-checkout-integration/
 */
export async function createVivaPaymentOrder(
  request: VivaPaymentRequest
): Promise<VivaPaymentSession> {
  try {
    if (!VIVA_API_KEY) {
      throw new Error(
        "Viva API key not configured. Set VIVA_API_KEY environment variable."
      );
    }

    const amountCents = Math.round(request.amount * 100);

    // Create payment order via Viva API
    // POST /checkout/v2/orders
    const orderPayload = {
      amount: amountCents,
      customerTrns: request.description,
      merchantTrns: `Order ${request.orderId}`,
      sourceCode: VIVA_SOURCE_CODE,
      paymentTimeout: 300, // 5 minutes
      preauth: false,
      allowRecurring: false,
      disableExactAmount: true,
      disableCash: true,
      customer: {
        email: request.customerEmail || "customer@example.com",
        fullName: request.customerName || "Customer",
        countryCode: "US",
        requestLang: "en-US",
      },
      tags: [
        "restaurant-order",
        `table-${request.tableId}`,
        `order-${request.orderId}`,
      ],
    };

    const response = await fetch(
      `${VIVA_DEMO_API_URL}/checkout/v2/orders`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${VIVA_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(orderPayload),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("Viva API error:", error);
      throw new Error(`Viva API error: ${response.status} - ${error}`);
    }

    const data = (await response.json()) as VivaCreateOrderResponse;

    if (!data.orderCode) {
      throw new Error("No order code returned from Viva");
    }

    // Build checkout URL with order code
    const orderCode = String(data.orderCode);
    const checkoutUrl = `${VIVA_DEMO_CHECKOUT_URL}?ref=${orderCode}`;

    return {
      checkoutUrl,
      orderCode,
      amount: request.amount,
    };
  } catch (error) {
    console.error("Failed to create Viva payment order:", error);
    throw error;
  }
}

/**
 * Verify a payment completion via webhook
 */
export function verifyVivaWebhook(
  payload: unknown
): payload is VivaWebhookPayload {
  if (!payload || typeof payload !== "object") return false;

  const p = payload as Record<string, unknown>;
  return (
    typeof p.transactionId === "string" &&
    typeof p.orderCode === "string" &&
    typeof p.amount === "number" &&
    typeof p.statusCode === "number" &&
    typeof p.merchantId === "string"
  );
}

/**
 * Check if payment was successful based on status code
 * Viva status codes: 1000 = captured, 1001 = pending
 */
export function isPaymentSuccessful(statusCode: number): boolean {
  return statusCode === 1000;
}

/**
 * Parse Viva redirect parameters from the payment completion URL
 * Viva redirects with: ?t={transactionId}&s={orderCode}&eventId=...&eci=...&lang=...
 */
export interface VivaRedirectParams {
  transactionId: string;
  orderCode: string;
  eventId?: string;
  eci?: string;
  lang?: string;
}

export function parseVivaRedirectParams(
  searchParams: URLSearchParams
): VivaRedirectParams | null {
  const transactionId = searchParams.get("t");
  const orderCode = searchParams.get("s");

  if (!transactionId || !orderCode) {
    return null;
  }

  return {
    transactionId,
    orderCode,
    eventId: searchParams.get("eventId") ?? undefined,
    eci: searchParams.get("eci") ?? undefined,
    lang: searchParams.get("lang") ?? undefined,
  };
}
