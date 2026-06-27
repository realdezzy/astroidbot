FROM node:23-alpine AS frontend-builder

WORKDIR /app/web

COPY web/package.json ./
RUN npm install --legacy-peer-deps

COPY shared/ /app/shared/
COPY web/ ./
RUN npm run build

FROM node:23-alpine AS backend

ENV NODE_ENV=production

RUN apk add --no-cache curl ffmpeg netcat-openbsd

RUN addgroup -g 1001 botgroup && adduser -u 1001 -G botgroup -s /bin/sh -D botuser

WORKDIR /app

COPY package.json ./
RUN npm install --legacy-peer-deps --omit=dev && npm cache clean --force

COPY prisma/ ./prisma/
RUN npx prisma generate

COPY shared/ ./shared/
COPY src/ ./src/
COPY Docs/ ./Docs/
COPY --from=frontend-builder /app/web/dist ./web/dist

RUN chown -R botuser:botgroup /app

COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh

EXPOSE 8006

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -f http://localhost:8006/api/health || exit 1

USER botuser

ENTRYPOINT ["/docker-entrypoint.sh"]
