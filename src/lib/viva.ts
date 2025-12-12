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
const VIVA_MERCHANT_ID = process.env.VIVA_MERCHANT_ID || "";
const VIVA_CLIENT_ID = process.env.VIVA_CLIENT_ID || "";
const VIVA_CLIENT_SECRET = process.env.VIVA_CLIENT_SECRET || "";
const VIVA_TOKEN_URL =
  process.env.VIVA_TOKEN_URL ||
  "https://demo-accounts.vivapayments.com/connect/token";

// Simple in-memory token cache
let cachedToken: string | null = null;
let cachedTokenExpiresAt = 0;

async function getVivaAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < cachedTokenExpiresAt - 5000) {
    console.log("[viva:token] using cached access_token");
    return cachedToken as string;
  }

  if (!VIVA_CLIENT_ID || !VIVA_CLIENT_SECRET) {
    throw new Error(
      "VIVA_CLIENT_ID and VIVA_CLIENT_SECRET must be set to use OAuth2 token flow"
    );
  }

  console.log("=== TOKEN REQUEST START ===");
  console.log(`[viva:token] requesting token from: ${VIVA_TOKEN_URL}`);

  // Build Basic auth header (matches Postman format)
  const credentials = `${VIVA_CLIENT_ID}:${VIVA_CLIENT_SECRET}`;
  const basicAuth = Buffer.from(credentials).toString("base64");
  console.log("[viva:token] basic auth credentials encoded");

  // Build form body with explicit URLSearchParams.append (matches Postman format)
  const formData = new URLSearchParams();
  formData.append("grant_type", "client_credentials");
  formData.append("scope", "urn:viva:payments:core:api:redirectcheckout");
  console.log(
    "[viva:token] form body built: grant_type=client_credentials, scope=urn:viva:payments:core:api:redirectcheckout"
  );

  // Make token request
  console.log("[viva:token] sending POST request...");
  const resp = await fetch(VIVA_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formData.toString(),
  });

  console.log(`[viva:token] response status: ${resp.status}`);
  const text = await resp.text();
  console.log(`[viva:token] response body length: ${text.length}`);

  // Check status code first
  if (resp.status !== 200) {
    console.error(
      `[viva:token] ✗ token fetch failed with status ${resp.status}`
    );
    console.error(`[viva:token] response body:`, text);
    throw new Error(`Viva token endpoint returned ${resp.status}: ${text}`);
  }

  // Parse JSON response
  try {
    const json = JSON.parse(text);
    console.log("[viva:token] response parsed as JSON");

    if (!json.access_token) {
      console.error("[viva:token] ✗ no access_token in response:", json);
      throw new Error(
        `Token endpoint returned no access_token: ${JSON.stringify(json)}`
      );
    }

    const token = json.access_token as string;
    cachedToken = token;
    const expiresIn =
      typeof json.expires_in === "number" ? json.expires_in : 3600;
    cachedTokenExpiresAt = Date.now() + expiresIn * 1000;

    console.log(`[viva:token] ✓ token obtained successfully`);
    console.log(
      `[viva:token] token length: ${token.length}, expires_in: ${expiresIn}s`
    );
    console.log("=== TOKEN REQUEST END ===");

    return token;
  } catch (err) {
    console.error("[viva:token] ✗ failed to parse token response:", text);
    console.error("[viva:token] parse error:", err);
    throw new Error(`Failed to obtain Viva access token: ${text}`);
  }
}

export interface VivaPaymentRequest {
  amount: number;
  orderId: string;
  tableId: string;
  description: string;
  customerEmail?: string;
  customerName?: string;
  returnUrl?: string;
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
    const amountCents = Math.round(request.amount * 100);

    // Create payment order via Viva API
    // POST /checkout/v2/orders
    const orderPayload: Record<string, unknown> = {
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

    // Add return URL if provided
    if (request.returnUrl) {
      orderPayload.returnUrl = request.returnUrl;
      console.log("[viva] return URL configured:", request.returnUrl);
    }

    // Log what we're sending to Viva but avoid printing secrets directly.
    console.log("[viva] POST", `${VIVA_DEMO_API_URL}/checkout/v2/orders`);
    console.log("[viva] headers", {
      Authorization: "[REDACTED]",
      "Content-Type": "application/json",
    });
    console.log("[viva] body", JSON.stringify(orderPayload));

    // Get OAuth2 access token
    console.log("[viva] fetching OAuth2 access token...");
    let accessToken: string;
    try {
      accessToken = await getVivaAccessToken();
      console.log("[viva] obtained access_token via OAuth2");
    } catch (tokenErr) {
      console.error("[viva] OAuth2 token fetch failed:", tokenErr);
      console.error("[viva] cannot proceed without valid token");
      throw tokenErr;
    }

    // Make the order creation request with OAuth2 Bearer token
    console.log("[viva] creating order with OAuth2 Bearer token...");
    const resp = await fetch(`${VIVA_DEMO_API_URL}/checkout/v2/orders`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        "User-Agent": "Garsone-Backend/1.0",
      },
      body: JSON.stringify(orderPayload),
    });

    const text = await resp.text();
    console.log(`[viva] order creation response status: ${resp.status}`);
    console.log(`[viva] order creation response body:`, text);

    if (resp.status !== 200) {
      console.error(`[viva] order creation failed with status ${resp.status}`);
      throw new Error(`Viva order creation failed: ${resp.status} - ${text}`);
    }

    const data = JSON.parse(text) as VivaCreateOrderResponse;
    if (!data.orderCode) {
      throw new Error("No order code returned from Viva");
    }

    // Build checkout URL with order code
    const orderCode = String(data.orderCode);
    const checkoutUrl = `${VIVA_DEMO_CHECKOUT_URL}?ref=${orderCode}`;

    console.log("[viva] ✓ order created successfully, orderCode:", orderCode);

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
