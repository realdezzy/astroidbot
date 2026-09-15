ALTER TABLE "Notification" ADD COLUMN "eventType" TEXT NOT NULL DEFAULT 'GENERAL';

CREATE TABLE "NotificationDelivery" (
  "id" TEXT NOT NULL, "notificationId" INTEGER NOT NULL, "channel" TEXT NOT NULL,
  "destination" TEXT NOT NULL, "topic" TEXT, "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0, "providerMessageId" TEXT,
  "idempotencyKey" TEXT NOT NULL, "lastError" TEXT, "deliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "NotificationDelivery_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "NotificationDelivery_idempotencyKey_key" ON "NotificationDelivery"("idempotencyKey");
CREATE INDEX "NotificationDelivery_status_createdAt_idx" ON "NotificationDelivery"("status", "createdAt");
CREATE INDEX "NotificationDelivery_notificationId_idx" ON "NotificationDelivery"("notificationId");
ALTER TABLE "NotificationDelivery" ADD CONSTRAINT "NotificationDelivery_notificationId_fkey"
  FOREIGN KEY ("notificationId") REFERENCES "Notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "AlertPreference" (
  "id" SERIAL NOT NULL, "userId" INTEGER NOT NULL, "channel" TEXT NOT NULL,
  "eventType" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT true,
  "cadence" TEXT NOT NULL DEFAULT 'INSTANT', "minimumSeverity" TEXT NOT NULL DEFAULT 'INFO',
  "quietStart" TEXT, "quietEnd" TEXT, "timezone" TEXT NOT NULL DEFAULT 'UTC',
  "settings" JSONB NOT NULL DEFAULT '{}', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "AlertPreference_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AlertPreference_userId_channel_eventType_key" ON "AlertPreference"("userId", "channel", "eventType");
CREATE INDEX "AlertPreference_userId_channel_idx" ON "AlertPreference"("userId", "channel");
ALTER TABLE "AlertPreference" ADD CONSTRAINT "AlertPreference_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "PriceAlert" (
  "id" TEXT NOT NULL, "userId" INTEGER NOT NULL, "chainId" TEXT NOT NULL,
  "contractId" TEXT NOT NULL, "symbol" TEXT NOT NULL, "condition" TEXT NOT NULL,
  "threshold" DOUBLE PRECISION NOT NULL, "cooldownSec" INTEGER NOT NULL DEFAULT 3600,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE', "lastFiredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PriceAlert_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "PriceAlert_userId_status_idx" ON "PriceAlert"("userId", "status");
CREATE INDEX "PriceAlert_chainId_contractId_status_idx" ON "PriceAlert"("chainId", "contractId", "status");
ALTER TABLE "PriceAlert" ADD CONSTRAINT "PriceAlert_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
