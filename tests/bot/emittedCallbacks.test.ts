import { describe, it, expect, beforeAll, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ConfigManager } from "../../src/config.js";

vi.mock("../../src/services/db.js", () => ({
  DatabaseService: {
    getInstance: () => ({
      prisma: {
        tradingStrategy: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
        tradeAgent: { create: vi.fn() },
      },
    }),
  },
}));

vi.mock("../../src/services/redis.js", () => ({
  RedisService: {
    getInstance: () => ({
      get: vi.fn().mockResolvedValue(null),
      set: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

/**
 * Every button the bot draws must be a button the bot can answer.
 *
 * `tests/bot/callbackRoutes.test.ts` asserts that the router *resolves* the
 * actions it knows about. That is a different claim from the one that matters
 * to a user, and the gap between them hid a whole dead feature: the token
 * screen emitted `token_show:<i>` and `token_trade:<i>` without the `action:`
 * prefix, and `handleCallback` rejects anything lacking it long before the
 * route table is consulted. The handlers existed, were registered, and were
 * covered — and every tap answered "This button has expired."
 *
 * So this test works the other way round: it reads the callback data the
 * screens and keyboards actually emit and asserts each one is reachable.
 */

const BOT_DIR = new URL("../../src/bot", import.meta.url).pathname;

/** Callback data that `handleCallback` answers before consulting the router. */
const SPECIAL_FORMS = [
  /^action:noop$/,
  /^home$/,
  /^screen:/,
  // Codec-encoded, pipe-separated ("wallet|new|base"), resolved by decodeCallback.
  /\|/,
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith(".ts") ? [full] : [];
  });
}

/**
 * Callback data emitted by keyboard builders.
 *
 * Matches grammY's `.text(label, data)` and raw `callback_data:` properties.
 * A `${...}` interpolation becomes a literal `X`, which is enough: routes are
 * matched by prefix, and the argument's value never decides reachability.
 */
function emittedCallbackData(source: string): string[] {
  const out: string[] = [];
  const quoted = String.raw`(?:\`[^\`]*\`|"[^"]*"|'[^']*')`;
  const patterns = [
    new RegExp(String.raw`\.text\(\s*${quoted}\s*,\s*(${quoted})`, "g"),
    new RegExp(String.raw`callback_data:\s*(${quoted})`, "g"),
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const raw = match[1]!;
      out.push(raw.slice(1, -1).replace(/\$\{[^}]*\}/g, "X"));
    }
  }
  return out;
}

describe("emitted callback data", () => {
  let router: import("../../src/bot/callbacks/registry.js").CallbackRouter;
  let bareCallbacks: Record<string, unknown>;

  beforeAll(async () => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    ConfigManager.reset();
    ConfigManager.load();

    const { CallbackRouter } = await import("../../src/bot/callbacks/registry.js");
    const { agentRoutes } = await import("../../src/bot/callbacks/agents.js");
    const { tradeRoutes } = await import("../../src/bot/callbacks/trade.js");
    const { walletRoutes } = await import("../../src/bot/callbacks/wallet.js");
    const mod = await import("../../src/bot/callbacks/system.js");

    router = new CallbackRouter().register(agentRoutes, tradeRoutes, walletRoutes, mod.systemRoutes);
    bareCallbacks = mod.bareCallbacks as Record<string, unknown>;
  }, 30000);

  function isReachable(data: string): boolean {
    if (SPECIAL_FORMS.some((form) => form.test(data))) return true;
    if (Object.prototype.hasOwnProperty.call(bareCallbacks, data)) return true;
    if (!data.startsWith("action:")) return false;
    return router.has(data.slice("action:".length));
  }

  it("reaches a handler for every button the bot draws", () => {
    const unreachable: { file: string; data: string }[] = [];

    for (const file of walk(BOT_DIR)) {
      const relative = file.slice(BOT_DIR.length + 1);
      for (const data of emittedCallbackData(readFileSync(file, "utf8"))) {
        if (!isReachable(data)) unreachable.push({ file: relative, data });
      }
    }

    expect(unreachable).toEqual([]);
  });

  it("recognises a missing action: prefix as unreachable", () => {
    // Guards the guard: if `isReachable` ever became permissive, the test
    // above would pass while the buttons stayed dead.
    expect(isReachable("token_trade:X")).toBe(false);
    expect(isReachable("action:token_trade:X")).toBe(true);
  });
});
