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

# Deliberately no `prisma migrate deploy` here.
#
# The bot container owns migrations. Two containers racing `migrate deploy` on
# boot is a coin flip that Prisma's advisory lock usually wins, and "usually"
# is not a property you want guarding a schema that holds wallet keys. Compose
# starts this service only once the bot is healthy, which is after its
# migrations have applied — so by the time we get here the schema is current,
# and if it isn't, failing fast is the correct outcome.

echo "==> Starting AstroidBot market-data indexer..."
exec npx tsx src/indexer.ts
