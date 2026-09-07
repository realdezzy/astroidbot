FROM node:22-alpine AS frontend-builder

WORKDIR /app/web

COPY web/package.json web/package-lock.json ./
RUN npm ci --legacy-peer-deps

COPY shared/ /app/shared/
COPY web/ ./
RUN npm run build

# Typecheck, lint gate, tests and the backend compile, in one stage.
#
# This stage produces `dist/`, and the runtime stage copies it — which is what
# makes the gate real. It used to build nothing anything depended on, so
# BuildKit skipped it entirely: `docker compose up --build` produced an image
# having run neither a test nor a typecheck, from a Dockerfile that read as
# though it gated on both.
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps

COPY prisma/ ./prisma/
RUN npx prisma generate

COPY shared/ ./shared/
COPY src/ ./src/
COPY tests/ ./tests/
COPY scripts/ ./scripts/
COPY tsconfig.json tsconfig.eslint.json eslint.config.js vitest.config.ts .lint-baseline.json ./

RUN npm run lint:gate && npm test && npm run build

FROM node:22-alpine AS backend

ENV NODE_ENV=production

RUN apk add --no-cache curl ffmpeg netcat-openbsd

RUN addgroup -g 1001 botgroup && adduser -u 1001 -G botgroup -s /bin/sh -D botuser

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --legacy-peer-deps --omit=dev && npm cache clean --force

COPY prisma/ ./prisma/

# Generated at build time rather than on every container start. The entrypoint
# used to run this on boot, which needs the network and adds tens of seconds
# before the process comes up — twice, since both entrypoints did it.
RUN npx prisma generate

# Compiled JavaScript, not TypeScript run through tsx. Nothing compiled used to
# ship: both entrypoints ran `npx tsx src/*.ts`, transpiling on demand at every
# boot and holding source maps in memory for the life of the process.
COPY --from=build /app/dist ./dist
COPY Docs/ ./Docs/
COPY --from=frontend-builder /app/web/dist ./web/dist

RUN chown -R botuser:botgroup /app

# One image, two entrypoints: the API/bot process and the market-data indexer
# share every dependency and all of src/, and building them separately would
# only create a way for the two to drift.
COPY docker-entrypoint.sh /docker-entrypoint.sh
COPY docker-entrypoint-indexer.sh /docker-entrypoint-indexer.sh
RUN chmod +x /docker-entrypoint.sh /docker-entrypoint-indexer.sh

EXPOSE 8006 8007

HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=5 \
  CMD curl -f http://localhost:8006/api/health || exit 1

USER botuser

ENTRYPOINT ["/docker-entrypoint.sh"]
