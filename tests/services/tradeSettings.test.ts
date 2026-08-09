import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * Settings resolve in two layers, and the split is the fix for a real defect.
 *
 * TradeSettings used to carry a `chain` column *and* a per-chain `sponsorGas`.
 * Every risk reader looked a row up by (userId, context) with an unordered
 * findFirst; the gas-sponsorship endpoint keyed rows by (userId, chain) and
 * created one when absent. Nothing constrained either shape, so toggling
 * sponsorship on a second chain inserted a duplicate (userId, "personal") row
 * full of product defaults — and from then on which limits RiskManager
 * enforced was up to the query planner.
 *
 * These tests pin the resolution order that replaced it.
 */

const findTradeSettings = vi.fn();
const findChainPreference = vi.fn();

vi.mock("../../src/services/db.js", () => ({
  DatabaseService: {
    getInstance: () => ({ findTradeSettings, findChainPreference }),
  },
}));

const { resolveTradeSettings, DEFAULT_TRADE_SETTINGS } = await import(
  "../../src/services/tradeSettings.js"
);

const ACCOUNT = {
  slippageBps: 150,
  maxPositionPct: 40,
  dailyLossLimit: 8,
  rebalanceThreshold: 3,
  useGasless: true,
  gaslessFeeToken: "USDC",
};

describe("resolveTradeSettings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findTradeSettings.mockResolvedValue(ACCOUNT);
    findChainPreference.mockResolvedValue(null);
  });

  it("uses the account settings when the chain has no opinion", async () => {
    const settings = await resolveTradeSettings(1, "personal", "base:mainnet");

    expect(settings.slippageBps).toBe(150);
    expect(settings.slippageIsChainOverride).toBe(false);
  });

  it("lets a chain override slippage", async () => {
    // The setting that most obviously differs per chain: a Stacks AMM and a
    // Solana aggregator are not the same trade at the same tolerance.
    findChainPreference.mockResolvedValue({ slippageBps: 400, sponsorGas: null });

    const settings = await resolveTradeSettings(1, "personal", "solana:mainnet");
    expect(settings.slippageBps).toBe(400);
    expect(settings.slippageIsChainOverride).toBe(true);
  });

  it("keeps exposure limits account-wide even when a chain row exists", async () => {
    // Per-chain position limits would let someone with three chains take three
    // times the position they asked to be limited to.
    findChainPreference.mockResolvedValue({ slippageBps: 400, sponsorGas: false });

    const settings = await resolveTradeSettings(1, "personal", "solana:mainnet");
    expect(settings.maxPositionPct).toBe(40);
    expect(settings.dailyLossLimit).toBe(8);
  });

  it("does not reset a preference to a product default when a chain row is added", async () => {
    // The old shape's actual failure: a sponsorship toggle wrote a fresh row
    // whose slippage/position/loss columns were defaults, and a later read
    // could return it instead of the user's own row.
    findChainPreference.mockResolvedValue({ slippageBps: null, sponsorGas: false });

    const settings = await resolveTradeSettings(1, "personal", "base:mainnet");
    expect(settings.slippageBps).toBe(ACCOUNT.slippageBps);
    expect(settings.maxPositionPct).toBe(ACCOUNT.maxPositionPct);
  });

  it("falls back to product defaults for a user who has saved nothing", async () => {
    findTradeSettings.mockResolvedValue(null);

    const settings = await resolveTradeSettings(1, "personal", "base:mainnet");
    expect(settings.slippageBps).toBe(DEFAULT_TRADE_SETTINGS.slippageBps);
    expect(settings.maxPositionPct).toBe(DEFAULT_TRADE_SETTINGS.maxPositionPct);
  });

  it("does not consult a chain row when asked without a chain", async () => {
    // The account settings screen edits the account layer, and should not be
    // shown one chain's override as though it were the default.
    await resolveTradeSettings(1, "personal");
    expect(findChainPreference).not.toHaveBeenCalled();
  });

  it("resolves to defaults rather than throwing when the lookup fails", async () => {
    // Every caller is on a trade path, and the defaults are the conservative
    // end of each range. A database blip should narrow what a trade may do,
    // not surface to the user as a failed swap.
    findTradeSettings.mockRejectedValue(new Error("db down"));

    const settings = await resolveTradeSettings(1, "personal", "base:mainnet");
    expect(settings).toMatchObject(DEFAULT_TRADE_SETTINGS);
  });
});
