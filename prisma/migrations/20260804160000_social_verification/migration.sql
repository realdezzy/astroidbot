-- Prove ownership of a social account before linking it.
--
-- Linking previously accepted `platformUserId` from the request body, so the
-- claim "this X account is mine" was attested by whoever made it. Anyone could
-- link any account's id. The consequences were bounded — a social command
-- trades from the linking user's own wallet, so the obvious attack costs the
-- attacker money — but it also let anyone permanently occupy someone else's
-- identifier (the unique key), locking the real owner out of ever linking.
--
-- Now the identifier is read off a post the account actually published, and
-- never comes from the client at all.
CREATE TABLE IF NOT EXISTS "SocialVerification" (
  "id"         SERIAL PRIMARY KEY,
  "userId"     INTEGER NOT NULL,
  "platform"   TEXT NOT NULL,
  "code"       TEXT NOT NULL,
  "expiresAt"  TIMESTAMP(3) NOT NULL,
  "consumedAt" TIMESTAMP(3),
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "SocialVerification_code_key"
  ON "SocialVerification"("code");
CREATE INDEX IF NOT EXISTS "SocialVerification_userId_platform_idx"
  ON "SocialVerification"("userId", "platform");
CREATE INDEX IF NOT EXISTS "SocialVerification_expiresAt_idx"
  ON "SocialVerification"("expiresAt");

-- Existing links were self-asserted and are therefore unverified by this
-- standard. They are left in place rather than deleted — deleting them would
-- silently disable trading for anyone relying on one — but verifiedAt is
-- cleared so they show as unverified in the UI and can be re-proved.
UPDATE "SocialAccount" SET "verifiedAt" = NULL;
