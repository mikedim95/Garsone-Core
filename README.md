# Garsone Core (OrderFlow Backend)

Backend API and realtime services for the OrderFlow restaurant ordering system.
Provides authentication, menu and order APIs, realtime events over MQTT and
WebSocket, payments via Viva Smart Checkout, and admin tooling for tables,
staff, menus, QR tiles, and assets.

## Features

- Role-based auth (waiter, cook, manager, architect)
- Menu endpoints and public menu bootstrap
- Order lifecycle with realtime updates (MQTT + WebSocket)
- Waiter table assignments and call-waiter alerts
- Admin/manager APIs for tables, staff roles, menu catalog, modifiers, QR tiles
- Asset uploads via R2 or Supabase (optional)
- Viva Smart Checkout payments + webhook listener

## Tech Stack

- Node.js + TypeScript (ESM)
- Fastify + Zod
- Prisma + PostgreSQL
- MQTT (EMQX compatible)
- WebSocket gateway (`/events/ws`)

## Project Layout

- `src/server.ts` - Fastify bootstrap and route registration
- `src/routes/` - HTTP endpoints
- `src/lib/` - MQTT, realtime, Viva, caching helpers
- `prisma/` - schema and seeds

## Getting Started

1. Install dependencies
   ```bash
   npm install
   ```
2. Configure environment variables (see below). Local dev loads `.env`.
3. Run database migrations and seed
   ```bash
   npm run db:migrate
   npm run db:seed
   ```
4. Start the API
   ```bash
   npm run dev
   ```

Default port: `8787` (override with `PORT`).

## Scripts

- `npm run dev` - start dev server with `tsx watch`
- `npm run build` - compile TypeScript to `dist`
- `npm start` - run compiled server
- `npm run db:generate` (alias: `npm run prisma:gen`) - Prisma client generation
- `npm run db:migrate` (alias: `npm run prisma:migrate`) - run migrations
- `npm run db:push` (alias: `npm run prisma:db-push`) - push schema without migrations
- `npm run db:seed` (alias: `npm run seed`) - seed database
- `npm run db:seed:render_internal` - seed using Render internal DB
- `npm run db:seed:render_external` - seed using Render external DB
- `npm run db:studio` - Prisma Studio
- `npm run db:test` - run Prisma IO test script

## Configuration

Local dev loads `.env` when `NODE_ENV` is not `production`. In production, set
environment variables via the host platform.

### Server

- `PORT` (default `8787`)
- `NODE_ENV`
- `LOG_LEVEL` (Fastify logger)
- `JWT_SECRET`, `JWT_EXPIRES_IN`
- `ENABLE_DEV_LOGIN` (set to `1` to allow `/auth/dev-login` in prod)
- `ALLOWED_IPS` (comma-separated list for IP whitelist)
- `ORDERS_DEFAULT_TAKE`, `ORDERS_MAX_TAKE` (order list limits)
- `TABLE_VISIT_TTL_MINUTES` (table visit token TTL)

### Database

- `DATABASE_URL` (required)
- `DIRECT_URL` (optional, for migrations)
- `DB_CONNECTION` (`primary` | `default` | `render_internal` | `render_external`)
- `DATABASE_URL_RENDER_INTERNAL`, `DATABASE_URL_RENDER_EXTERNAL`
- `DIRECT_URL_RENDER_INTERNAL`, `DIRECT_URL_RENDER_EXTERNAL`
- `PRISMA_LOG_QUERIES` (`1` to log queries)

### MQTT / Realtime

- `MQTT_DISABLED` (`true` to disable broker)
- `EMQX_URL` or `MQTT_URL` or `MQTT_BROKER_URL`
- `EMQX_USERNAME` / `MQTT_USERNAME`
- `EMQX_PASSWORD` / `MQTT_PASSWORD`
- `MQTT_CLIENT_ID`, `MQTT_KEEPALIVE`, `MQTT_RECONNECT_MS`, `MQTT_QOS`
- `MQTT_REJECT_UNAUTHORIZED`, `MQTT_DEBUG`
- `STORE_SLUG` (default `default-store`)

### Frontend / Public URLs

- `FRONTEND_BASE_URL` (payment return URL)
- `FRONTEND_ORIGIN`, `FRONTEND_PORT`
- `PUBLIC_APP_BASE_URL`
- `PUBLIC_APP_DOMAIN`, `PUBLIC_APP_PROTOCOL`, `PUBLIC_APP_PORT`
- `OPS_APP_BASE_URL`, `OPS_APP_PATH`

### Assets (optional)

- Cloudflare R2: `R2_S3_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID` or
  `R2_ACCESS_KEY`, `R2_SECRET_ACCESS_KEY` or `R2_SECRET_KEY`,
  `R2_PUBLIC_BASE_URL`, `R2_REGION`
- Supabase: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` or
  `SUPABASE_SERVICE_KEY`, `SUPABASE_BUCKET`

### Payments (Viva)

- `VIVA_API_KEY`, `VIVA_SOURCE_CODE`
- `VIVA_CLIENT_ID`, `VIVA_CLIENT_SECRET`, `VIVA_MERCHANT_ID`
- `VIVA_TOKEN_URL`
- `VIVA_CURRENCY_CODE` (default `978` for EUR)

## API Overview

This is not exhaustive; see `src/routes/` for details.

- Health: `GET /health`
- Auth: `POST /auth/signin`, `GET /auth/dev-login/:storeSlug/:userKey`
- Menu: `GET /menu`, `GET /public/menu-bootstrap`
- Store: `GET /store`, `GET /tables`, `GET /landing/stores`
- Orders: `POST /orders`, `GET /orders`, `PATCH /orders/:id`,
  `POST /orders/:id/print`, `GET /orders/queue`,
  `GET /public/table/:id/orders`, `POST /call-waiter`
- Payments: `POST /payment/viva/checkout-url`,
  `POST /payments/viva/webhook`
- Realtime: `GET /events/ws?token=...` (WebSocket), `POST /events/publish`
- QR tiles: `GET /q/:publicCode`, `GET /public/table/:tableId`,
  admin routes under `/admin/.../qr-tiles`

## Viva Docs

- `VIVA_SETUP.md`
- `VIVA_COMPLIANCE_CHECKLIST.md`

## Notes

- MQTT publishes order and waiter events to `{storeSlug}/...` topics.
- WebSocket events mirror MQTT payloads for browser clients.
