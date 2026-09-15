CREATE TABLE "PendingAction" (
    "id" TEXT NOT NULL,
    "userId" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "quoteSnapshot" JSONB,
    "source" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "PendingAction_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PendingAction_idempotencyKey_key" ON "PendingAction"("idempotencyKey");
CREATE INDEX "PendingAction_userId_status_createdAt_idx" ON "PendingAction"("userId", "status", "createdAt");
CREATE INDEX "PendingAction_status_expiresAt_idx" ON "PendingAction"("status", "expiresAt");
ALTER TABLE "PendingAction" ADD CONSTRAINT "PendingAction_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
