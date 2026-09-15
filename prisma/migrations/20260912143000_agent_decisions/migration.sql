CREATE TABLE "AgentDecision" (
  "id" TEXT NOT NULL,
  "userId" INTEGER NOT NULL,
  "strategyId" INTEGER NOT NULL,
  "agentId" INTEGER,
  "outcome" TEXT NOT NULL,
  "observed" JSONB NOT NULL,
  "triggeredRule" TEXT,
  "expectedRisk" JSONB NOT NULL,
  "confidence" DOUBLE PRECISION,
  "action" JSONB,
  "explanation" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AgentDecision_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AgentDecision_userId_createdAt_idx" ON "AgentDecision"("userId", "createdAt");
CREATE INDEX "AgentDecision_strategyId_createdAt_idx" ON "AgentDecision"("strategyId", "createdAt");
CREATE INDEX "AgentDecision_agentId_createdAt_idx" ON "AgentDecision"("agentId", "createdAt");
ALTER TABLE "AgentDecision" ADD CONSTRAINT "AgentDecision_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentDecision" ADD CONSTRAINT "AgentDecision_strategyId_fkey" FOREIGN KEY ("strategyId") REFERENCES "TradingStrategy"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AgentDecision" ADD CONSTRAINT "AgentDecision_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "TradeAgent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
