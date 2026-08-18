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
if ! npx prisma migrate deploy; then
  echo "==> Existing un-baselined database schema detected. Baselining migration history..."
  for m in 20250620000000_init 20260726120000_multichain_wallets_and_catchup 20260726220000_wallet_chain_index 20260727000000_token_catalogue_and_candle_chain 20260727010000_social_trading 20260802000000_market_data_indexer 20260804120000_split_indexed_token 20260804140000_indexer_backfill 20260804150000_gas_sponsorship 20260804160000_social_verification 20260804170000_pool_last_signature 20260804180000_indexed_swaps 20260808120000_backfill_transaction_chains 20260809120000_split_chain_preferences 20260809130000_trade_chain; do
    npx prisma migrate resolve --applied "$m" 2>/dev/null || true
  done
  echo "==> Re-running migration deploy..."
  npx prisma migrate deploy
fi

echo "==> Starting AstroidBot..."
exec npx tsx src/index.ts
