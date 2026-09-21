# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS deps

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

FROM deps AS build

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim AS runtime

WORKDIR /app

# This published image targets a Pi behind one Front nginx proxy. Keep these
# defaults for older node agents that do not pass local-mode settings yet.
ENV NODE_ENV=production \
  PORT=8787 \
  LOCAL_ONLY=true \
  TRUST_PROXY_HOPS=1

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl tini \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system nodejs \
  && useradd --system --gid nodejs --home-dir /app nodejs

COPY package*.json ./
COPY tsconfig.json ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY prisma ./prisma
COPY qr_codes.txt ./qr_codes.txt
COPY src ./src
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY deploy/pi/full-stack/venue-data.mjs deploy/pi/full-stack/bootstrap-admin.mjs ./tools/

RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
  && mkdir -p /app/uploads /app/print-spool \
  && chown -R nodejs:nodejs /app

USER nodejs

EXPOSE 8787

ENTRYPOINT ["tini", "--", "docker-entrypoint.sh"]
CMD ["npm", "start"]
