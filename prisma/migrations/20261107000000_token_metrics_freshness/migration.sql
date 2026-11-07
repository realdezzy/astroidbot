-- Token catalogue freshness and routability.
--
-- `metricsUpdatedAt` is the only column that means "the active market-data
-- provider last confirmed these numbers". `lastSyncedAt` and `updatedAt` are
-- bumped by identity-only syncs too, which is why a discovery page fed by an
-- external provider could show months-old prices while claiming to be synced.
--
-- `isRoutable` distinguishes a token we catalogue because an external feed
-- knows it from one a registered DEX provider can actually execute against.
ALTER TABLE "Token" ADD COLUMN "isRoutable" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Token" ADD COLUMN "metricsUpdatedAt" TIMESTAMP(3);
