#!/bin/sh
set -e

echo "==> Waiting for Postgres (port 5432 on postgres host)..."
until nc -z postgres 5432 2>/dev/null; do
  echo "   Postgres is unavailable — sleeping 2s"
  sleep 2
done
echo "   Postgres is ready."

echo "==> Generating Prisma client..."
npx prisma generate

echo "==> Pushing database schema..."
npx prisma db push

echo "==> Starting AstroidBot..."
exec npx tsx src/index.ts
