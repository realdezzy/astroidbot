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

# migrate deploy, not db push: push refuses any change it considers risky (it
# blocked the Wallet chainFamily unique-key change and crash-looped this
# container under `set -e`), and --accept-data-loss would trade that for
# silently applying destructive changes to a database holding wallet keys.
# Migrations are reviewed SQL, checked into prisma/migrations.
#
# A database provisioned by the old db push path already has the schema and
# must be baselined once, or deploy will fail trying to re-create objects:
#   npx prisma migrate resolve --applied 20250620000000_init
#   npx prisma migrate resolve --applied 20260726120000_multichain_wallets_and_catchup
echo "==> Applying database migrations..."
npx prisma migrate deploy

echo "==> Starting AstroidBot..."
exec npx tsx src/index.ts
