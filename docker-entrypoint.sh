#!/bin/sh
set -e

echo "==> Waiting for Postgres (port 5432 on postgres host)..."
until nc -z postgres 5432 2>/dev/null; do
  echo "   Postgres is unavailable — sleeping 2s"
  sleep 2
done
echo "   Postgres is ready."

# migrate deploy, not db push: push refuses any change it considers risky (it
# blocked the Wallet chainFamily unique-key change and crash-looped this
# container under `set -e`), and --accept-data-loss would trade that for
# silently applying destructive changes to a database holding wallet keys.
# Migrations are reviewed SQL, checked into prisma/migrations.
#
# A database provisioned by the old db push path already has the schema and
# must be baselined once, or deploy will fail trying to re-create objects.
# Every migration except the newest describes schema that push already applied,
# so mark them applied without running them, then let deploy run the rest:
#
#   for m in $(ls prisma/migrations | grep -v migration_lock.toml | sort | head -n -1); do
#     npx prisma migrate resolve --applied "$m"
#   done
#
# Check `npx prisma migrate status` first — if it reports no applied
# migrations and the tables exist, this is the database that needs it.
echo "==> Applying database migrations..."
npx prisma migrate deploy

echo "==> Starting AstroidBot..."
exec node dist/src/index.js
