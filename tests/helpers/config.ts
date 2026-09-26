import { ConfigManager } from "../../src/config.js";

/**
 * Loads a minimal valid config for a unit test.
 *
 * Several services read `ConfigManager.getInstance()` lazily — the market-data
 * provider, the candle source, the quant switch — so a suite that never loaded
 * a config fails with "ConfigManager not initialized" from whichever line
 * happened to touch it first, which says nothing about the test. The required
 * values here are the four the schema refuses to default.
 */
let previousExtras: string[] = [];

export function loadTestConfig(extra: Record<string, string> = {}): void {
  // Anything a previous call set is cleared first. `process.env` outlives a
  // test, so without this a suite whose third case sets `INDEXER_MODE=full`
  // silently runs its fourth case in full mode too — and the resulting failure
  // points at the wrong test, or worse, doesn't happen until the file is run
  // in a different order.
  for (const key of previousExtras) delete process.env[key];
  previousExtras = Object.keys(extra);

  process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
  process.env.AES_KEY = "testkey";
  process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";

  // Set to the empty string by a `.env` in some checkouts, which fails the
  // schema's URL validation rather than being treated as absent.
  if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
  if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;

  Object.assign(process.env, extra);

  ConfigManager.reset();
  ConfigManager.load();
}
