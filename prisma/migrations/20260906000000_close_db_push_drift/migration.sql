-- Objects that reached production through `prisma db push` and were never
-- given a migration.
--
-- The entrypoint ran `db push --accept-data-loss`, so schema.prisma was the
-- only record of these: PushSubscription (an entire table), and the
-- IndexedPool.lifecycleState / IndexedSwap.traderAddress columns their code
-- already reads and writes. Deploying the migration history alone produced a
-- database the application immediately fails against — push notifications
-- 500, and every swap insert rejects an unknown column.
--
-- Written IF NOT EXISTS throughout because the databases that need this most
-- are the ones push already provisioned, where these objects exist and the
-- history does not know it.
-- DropForeignKey
ALTER TABLE "IndexedSwap" DROP CONSTRAINT IF EXISTS "IndexedSwap_poolId_fkey";

-- DropForeignKey
ALTER TABLE "SocialAccount" DROP CONSTRAINT IF EXISTS "SocialAccount_userId_fkey";

-- DropForeignKey
ALTER TABLE "SocialCommand" DROP CONSTRAINT IF EXISTS "SocialCommand_socialAccountId_fkey";

-- AlterTable
ALTER TABLE "IndexedPool" ADD COLUMN IF NOT EXISTS "lifecycleState" TEXT NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "IndexedSwap" ADD COLUMN IF NOT EXISTS "traderAddress" TEXT;

-- CreateTable
CREATE TABLE IF NOT EXISTS "PushSubscription" (
    "id" SERIAL NOT NULL,
    "userId" INTEGER NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PushSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "PushSubscription_endpoint_key" ON "PushSubscription"("endpoint");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "PushSubscription_userId_idx" ON "PushSubscription"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "IndexedPool_chainId_lifecycleState_idx" ON "IndexedPool"("chainId", "lifecycleState");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "IndexedSwap_traderAddress_idx" ON "IndexedSwap"("traderAddress");

-- AddForeignKey
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IndexedSwap" ADD CONSTRAINT "IndexedSwap_poolId_fkey" FOREIGN KEY ("poolId") REFERENCES "IndexedPool"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialCommand" ADD CONSTRAINT "SocialCommand_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE SET NULL ON UPDATE CASCADE;

