-- Split per-chain preferences out of TradeSettings.
--
-- TradeSettings was two tables wearing one name. Every risk reader looked a row
-- up by (userId, context) with an unordered findFirst; the gas-sponsorship
-- endpoint keyed rows by (userId, chain) and *created* one when absent. Nothing
-- constrained either shape, so toggling sponsorship on a second chain inserted a
-- duplicate (userId, 'personal') row carrying default slippage, position and
-- loss limits — and from then on which row RiskManager enforced was up to the
-- query planner.
--
-- Order matters here: preferences are copied out before any row is deleted.

-- 1. The new home for anything that is genuinely per chain.
CREATE TABLE IF NOT EXISTS "ChainPreference" (
    "id"          SERIAL       NOT NULL,
    "userId"      INTEGER      NOT NULL,
    "chainId"     TEXT         NOT NULL,
    -- Nullable on purpose: a row states only what it overrides, so a chain
    -- never inherits a product default in place of the user's own setting.
    "sponsorGas"  BOOLEAN,
    "slippageBps" INTEGER,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChainPreference_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ChainPreference_userId_chainId_key"
    ON "ChainPreference"("userId", "chainId");

ALTER TABLE "ChainPreference"
    ADD CONSTRAINT "ChainPreference_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 2. Carry every existing sponsorship choice across before anything is dropped.
--
-- Only non-default choices are copied. A row left at sponsorGas = true is
-- indistinguishable from one nobody ever touched, and copying it would create
-- an override that says nothing.
INSERT INTO "ChainPreference" ("userId", "chainId", "sponsorGas", "updatedAt")
SELECT DISTINCT ON ("userId", "chain")
       "userId", "chain", "sponsorGas", CURRENT_TIMESTAMP
FROM "TradeSettings"
WHERE "sponsorGas" = false
ORDER BY "userId", "chain", "id" ASC
ON CONFLICT ("userId", "chainId") DO NOTHING;

-- 3. Collapse the duplicates the old shape allowed.
--
-- The oldest row per (userId, context) wins: it is the one the settings flow
-- created, so it holds whatever the user actually configured. The later ones
-- are sponsorship artefacts whose only real content is the flag just copied
-- above — every other column in them is a product default.
DELETE FROM "TradeSettings" t
USING "TradeSettings" keep
WHERE t."userId"  = keep."userId"
  AND t."context" = keep."context"
  AND t."id"      > keep."id";

-- 4. Now the constraint that makes the duplicate unrepresentable.
ALTER TABLE "TradeSettings" DROP COLUMN IF EXISTS "chain";
ALTER TABLE "TradeSettings" DROP COLUMN IF EXISTS "sponsorGas";

CREATE UNIQUE INDEX IF NOT EXISTS "TradeSettings_userId_context_key"
    ON "TradeSettings"("userId", "context");
