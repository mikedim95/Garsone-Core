# Viva Payments Smart Checkout Integration Guide

This guide walks through setting up Viva Payments Smart Checkout in the Garsone restaurant ordering system.

⚠️ **Official Viva Guidelines Followed:**
This implementation strictly adheres to Viva's official specifications:

- [Smart Checkout Integration](https://developer.viva.com/smart-checkout/smart-checkout-integration/)
- [Payment API](https://developer.viva.com/apis-for-payments/payment-api/)
- [Webhooks for Payments](https://developer.viva.com/webhooks-for-payments/)

## Overview

The integration enables customers to:

1. Place an order from the restaurant menu
2. Backend creates a payment order via Viva Payment API
3. User is redirected to Viva Smart Checkout portal (full page redirect, not iframe)
4. User completes payment with any available payment method
5. User is redirected back with payment confirmation
6. Order is created in the database

**Key Implementation Details:**

- ✅ Backend-created orders (secure, PCI-compliant)
- ✅ Full page redirect (best payment method support per Viva guidelines)
- ✅ NOT embedded in iframe (Viva does not recommend iframe embedding)
- ✅ Webhook-ready for payment status notifications (optional)

The payment flow is:

```
Menu → Checkout → Backend Creates Viva Payment Order
  → Returns OrderCode to Frontend → Full Page Redirect to Smart Checkout Portal
  → User Completes Payment → Viva Redirects Back → Order Created → Confirmation
```

**Viva Payment Methods Supported:**

- Credit/Debit Cards (Visa, Mastercard, etc.)
- Bank Transfers
- Digital Wallets
- Buy Now, Pay Later
- Regional Payment Methods

(All methods displayed on Smart Checkout page based on Viva merchant configuration)

## Prerequisites

- Viva Payments demo account: https://demo.vivapayments.com
- API Key from Viva demo account
- Payment Source Code (4-digit number) created in your Viva merchant dashboard

## Setup Steps

### 1. Create a Viva Demo Account

1. Visit https://demo.vivapayments.com
2. Sign up for a new account
3. Complete profile verification
4. Access your merchant dashboard

### 2. Create a Payment Source

1. In the Viva merchant dashboard, navigate to "Settings" → "Payment Sources"
2. Click "Add Payment Source"
3. Configure:
   - **Name**: "Garsone Restaurant" (or your preference)
   - **Type**: Smart Checkout
4. Save and note the **4-digit Source Code** (e.g., `1234`)

### 3. Generate API Credentials

1. In the Viva merchant dashboard, navigate to "Settings" → "API Keys"
2. Create a new API key
3. Copy the **API Key** (long string starting with your merchant ID)

### 4. Configure Environment Variables

Create or update your `.env.local` file in the `Garsone-Core` directory:

```env
# Viva Payments Configuration
VIVA_API_KEY=your_api_key_here
VIVA_SOURCE_CODE=1234
```

Replace:

- `your_api_key_here` with your actual Viva API key
- `1234` with your actual payment source code

### 5. Set the Return URL

The payment completion URL is:

```
http://localhost:5173/payment-complete
```

When you deploy to production, update this in:

- Frontend: `Garsone-Front/src/features/menu/TableMenu.tsx` (handleCheckout function)
- Viva Dashboard: Set your domain in Settings → Redirect URLs

## Testing

### 1. Test Cards

Use these Viva test card numbers (available at https://developer.viva.com/getting-started/test-cards):

**Successful Payment:**

- Card: `4111111111111111`
- Expiry: Any future date
- CVV: Any 3 digits
- Amount: €0.30 or more

**Failed Payment:**

- Card: `4111111111111112`
- Expiry: Any future date
- CVV: Any 3 digits

### 2. Test the Flow

1. Start the development servers:

   ```bash
   # Terminal 1: Backend
   cd Garsone-Core
   npm run dev

   # Terminal 2: Frontend
   cd Garsone-Front
   npm run dev
   ```

2. Open http://localhost:5173
3. Scan a table QR code or navigate to menu
4. Add items to cart
5. Click "Checkout"
6. You'll be redirected to Viva's demo checkout portal
7. Use test card `4111111111111111` for successful payment
8. After payment, you'll be redirected back to `/payment-complete`
9. Order will be created and you'll see the "Order Confirmed" page

## Code Architecture

### Backend (Garsone-Core)

**Key Files:**

- `src/lib/viva.ts` - Viva API integration library

  - `createVivaPaymentOrder()` - Creates payment order with Viva API
  - `parseVivaRedirectParams()` - Parses Viva's redirect query parameters
  - `verifyVivaWebhook()` - Validates webhook payload (optional)
  - `isPaymentSuccessful()` - Checks payment status

- `src/routes/orders.ts`

  - `POST /payment/viva/checkout-url` - Generates checkout URL
  - Accepts: tableId, amount, description
  - Returns: checkoutUrl, sessionId, amount, tableId

- `prisma/schema.prisma`
  - New PaymentStatus enum (PENDING, PROCESSING, COMPLETED, FAILED, CANCELLED)
  - Order model extended with: paymentStatus, paymentProvider, paymentId, paymentError

### Frontend (Garsone-Front)

**Key Files:**

- `src/features/menu/TableMenu.tsx`

  - `handleCheckout()` - Initiates payment flow
  - Calculates total with modifiers
  - Calls backend to get Viva checkout URL
  - Stores pending order in sessionStorage
  - Redirects to Viva payment portal

- `src/features/payment/PaymentCompletePage.tsx`

  - Handles redirect from Viva
  - Verifies table ID matches pending order
  - Creates order in database
  - Clears cart and redirects to order confirmation

- `src/lib/api.ts`

  - `getVivaCheckoutUrl()` - API call to backend payment endpoint

- `src/App.tsx`
  - Route: `/payment-complete` → PaymentCompletePage

## API Endpoints

### Create Payment Order

```http
POST /payment/viva/checkout-url
Content-Type: application/json

{
  "tableId": "uuid-here",
  "amount": 42.50,
  "description": "Order for Table 5"
}
```

**Response:**

```json
{
  "checkoutUrl": "https://demo.vivapayments.com/web/checkout?ref=1234567890123456",
  "sessionId": "store-id_table-id_timestamp",
  "amount": 42.5,
  "tableId": "uuid-here"
}
```

## Environment Variables Reference

| Variable           | Description                    | Example                            |
| ------------------ | ------------------------------ | ---------------------------------- |
| `VIVA_API_KEY`     | Your Viva demo API key         | `Bearer token from Viva dashboard` |
| `VIVA_SOURCE_CODE` | Payment source code (4 digits) | `1234`                             |

## Troubleshooting

### "Viva API key not configured"

- Ensure `VIVA_API_KEY` is set in `.env.local`
- Restart the backend server after adding environment variables

### "OrderOrderCodeNotFound" error from Viva

- This means the order creation API call failed
- Check that `VIVA_API_KEY` and `VIVA_SOURCE_CODE` are correct
- Verify the API key has sufficient permissions in Viva dashboard

### Payment redirect doesn't work

- Ensure `/payment-complete` route exists in frontend (it does by default)
- Check browser console for JavaScript errors
- Verify sessionStorage is available (not disabled)

### Order doesn't appear after payment

- Check that payment was actually successful on Viva portal
- Look at browser console for API errors
- Verify table ID matches between payment and order creation
- Check database for Order records with matching table ID

## Production Deployment

### 1. Create Production Viva Account

Visit https://www.vivapayments.com to create a production merchant account.

### 2. Update Configuration

Change environment variables:

```env
# Production Viva credentials
VIVA_API_KEY=your_production_api_key
VIVA_SOURCE_CODE=your_production_source_code
```

Update API endpoints in `src/lib/viva.ts`:

```typescript
// Change from:
const VIVA_DEMO_API_URL = "https://demo-api.vivapayments.com";
const VIVA_DEMO_CHECKOUT_URL = "https://demo.vivapayments.com/web/checkout";

// To:
const VIVA_API_URL = "https://api.vivapayments.com";
const VIVA_CHECKOUT_URL = "https://www.vivapayments.com/web/checkout";
```

### 3. Update Frontend Return URL

Update the return URL in `TableMenu.tsx` to your production domain:

```typescript
const baseUrl = "https://your-domain.com"; // instead of localhost
```

### 4. Register Webhook

In Viva dashboard, register webhook URL for payment notifications:

```
https://your-domain.com/webhooks/payments/viva/webhook
```

This optional webhook receives payment confirmation after redirect.

## Currency Notes

- All amounts in the API are in **cents** (integer)
- The Viva API converts: `amount * 100` = cents
- Display currency is **EUR** (€)

## Security Notes - Viva Compliance

✅ **PCI Compliance:**

- Payment details are entered on Viva's secure servers, NOT your application
- Your backend never handles raw payment card data
- Fully compliant with PCI DSS standards
- Viva handles all compliance requirements

✅ **Implementation Security:**

- Store API key securely in environment variables only
- Never commit `.env.local` to version control
- Use HTTPS in production (required by Viva)
- Validate all payment amounts on backend before creating orders
- Verify table ownership before order creation
- Use Bearer token authentication (OAuth2) for API calls

✅ **Payment Flow Security (Redirect-Based):**

- User is redirected to Viva's official domain (not embedded)
- All payment processing happens on Viva's secure servers
- Session tokens used to match pending orders
- Payment status verified via webhooks (optional but recommended for production)
- No sensitive data transmitted through your frontend

✅ **Do NOT (Per Viva Guidelines):**

- ❌ Never embed Smart Checkout in an iframe (Viva does not recommend)
- ❌ Never attempt to capture card data directly
- ❌ Never store unencrypted payment information
- ❌ Never skip HTTPS in production
- ❌ Never process payments client-side

## Support

For issues with the Viva API:

- Official Docs: https://developer.viva.com/
- Smart Checkout Guide: https://developer.viva.com/smart-checkout/smart-checkout-integration/
- Payment API: https://developer.viva.com/apis-for-payments/payment-api/
- Webhooks: https://developer.viva.com/webhooks-for-payments/
- Test Cards: https://developer.viva.com/getting-started/test-cards
- Status Codes: https://developer.viva.com/getting-started/status-codes
- Customization: https://developer.viva.com/smart-checkout/customization-options/

For Garsone integration issues, check:

- Backend logs: `Garsone-Core/logs`
- Frontend console: Browser DevTools → Console
- Database: Check Order records and payment status
