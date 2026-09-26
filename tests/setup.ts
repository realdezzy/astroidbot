/**
 * A hermetic baseline environment for every unit test.
 *
 * `src/config.ts` calls `dotenv.config()` at import time, so until this file
 * existed the suite read whatever was in the developer's `.env`. That made
 * `npm test` pass on a machine with a populated `.env` and fail everywhere
 * else: `AI_PROVIDER` defaults to "openai", so on a clean checkout
 * `ConfigManager` threw "OPENAI_API_KEY is required when AI_PROVIDER is openai"
 * before a single assertion ran, and everything that builds a server on top of
 * it then failed again on `server.close()` of an undefined server.
 *
 * That is not a theoretical gap. The Dockerfile's build stage runs
 * `npm run lint:gate && npm test && npm run build` as the deploy gate, and
 * `.dockerignore` (correctly) keeps `.env` out of the image — so the gate could
 * not pass, and `docker compose build` failed on every clean build. CI sets
 * three variables and would have hit the same wall.
 *
 * Two rules here:
 *
 * - Secrets are **forced**, not defaulted. A developer's real `OPENAI_API_KEY`
 *   reaching a test is how a suite starts making billed API calls against a
 *   live account; a test that needs a specific value assigns it itself, which
 *   still wins because this file runs before the test body.
 * - Everything else is set only when absent, so a deliberate override in the
 *   shell or in a test's own setup survives.
 *
 * `NODE_ENV=test` keeps `assertNoPlaceholders` disarmed, which is what lets
 * these obviously-fake values be used at all.
 */

process.env.NODE_ENV ??= "test";

/** Forced: a real credential must never reach a test. */
process.env.OPENAI_API_KEY = "test-openai-key-not-a-real-credential";

/** Defaulted: the values the schema refuses to invent for itself. */
process.env.ASTROIDBOT_DATABASE_URL ??= "postgresql://localhost:5432/test";
process.env.AES_KEY ??= "testkey";
process.env.JWT_SECRET ??= "change-me-in-production-to-32-char-min-xyz";

/**
 * Some checkouts carry these as empty strings, which fails the schema's URL
 * validation instead of reading as absent. Deleting is not the same as leaving
 * them: `z.string().url().optional()` accepts undefined and rejects "".
 */
for (const key of ["TELEGRAM_WEBHOOK_URL", "VELUMX_RELAYER_URL"] as const) {
  if (process.env[key] === "") delete process.env[key];
}
