-- Social trading: linked accounts and a record of every inbound command.

CREATE TABLE IF NOT EXISTS "SocialAccount" (
  "id"               SERIAL PRIMARY KEY,
  "userId"           INTEGER NOT NULL REFERENCES "User"("id"),
  "platform"         TEXT NOT NULL,
  -- Immutable platform identifier. Handles are transferable, so authorizing
  -- on a handle would let whoever acquires an abandoned @name move funds.
  "platformUserId"   TEXT NOT NULL,
  "handle"           TEXT NOT NULL,
  "verifiedAt"       TIMESTAMP(3),
  "perTradeLimitUsd" DOUBLE PRECISION NOT NULL DEFAULT 50,
  "dailyLimitUsd"    DOUBLE PRECISION NOT NULL DEFAULT 200,
  "autoExecute"      BOOLEAN NOT NULL DEFAULT false,
  "enabled"          BOOLEAN NOT NULL DEFAULT true,
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        TIMESTAMP(3) NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "SocialAccount_platform_platformUserId_key"
  ON "SocialAccount"("platform", "platformUserId");
CREATE INDEX IF NOT EXISTS "SocialAccount_userId_idx" ON "SocialAccount"("userId");

CREATE TABLE IF NOT EXISTS "SocialCommand" (
  "id"               SERIAL PRIMARY KEY,
  "socialAccountId"  INTEGER REFERENCES "SocialAccount"("id"),
  "platform"         TEXT NOT NULL,
  "postId"           TEXT NOT NULL,
  "authorId"         TEXT NOT NULL,
  "rawText"          TEXT NOT NULL,
  "parsedIntent"     TEXT,
  "status"           TEXT NOT NULL DEFAULT 'RECEIVED',
  "rejectionReason"  TEXT,
  "tradeId"          INTEGER,
  "confirmToken"     TEXT,
  "confirmExpiresAt" TIMESTAMP(3),
  "createdAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Idempotency guard. Streams redeliver, webhooks retry, and a restart can
-- replay a backlog; without this the same post could trade more than once.
CREATE UNIQUE INDEX IF NOT EXISTS "SocialCommand_platform_postId_key"
  ON "SocialCommand"("platform", "postId");
CREATE UNIQUE INDEX IF NOT EXISTS "SocialCommand_confirmToken_key"
  ON "SocialCommand"("confirmToken");
CREATE INDEX IF NOT EXISTS "SocialCommand_socialAccountId_createdAt_idx"
  ON "SocialCommand"("socialAccountId", "createdAt");
