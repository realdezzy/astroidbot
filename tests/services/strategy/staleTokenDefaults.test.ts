import { describe, it, expect } from "vitest";
import { planStaleTokenRepair } from "../../../src/services/strategy/staleTokenDefaults.js";

describe("planStaleTokenRepair", () => {
  it("strips Stacks default legs from a strategy whose wallets are all off Stacks", () => {
    const plan = planStaleTokenRepair(
      { walletIds: [1], tokenIn: "STX", tokenOut: "USDCx", amount: 5 },
      ["base:mainnet"]
    );

    expect(plan).toEqual({
      action: "repair",
      removed: { tokenIn: "STX", tokenOut: "USDCx" },
      config: { walletIds: [1], amount: 5 },
    });
  });

  it("matches the old form default pair as well as the schema's", () => {
    const plan = planStaleTokenRepair({ tokenPair: "STX/sUSDT" }, ["solana:mainnet", "celo:mainnet"]);
    expect(plan).toMatchObject({ action: "repair", removed: { tokenPair: "STX/sUSDT" } });
  });

  it("keeps a leg the user typed, removing only the default beside it", () => {
    const plan = planStaleTokenRepair({ tokenIn: "STX", tokenOut: "AERO" }, ["base:mainnet"]);
    expect(plan).toMatchObject({ action: "repair", config: { tokenOut: "AERO" } });
    expect(plan.action === "repair" && "tokenIn" in plan.config).toBe(false);
  });

  // STX/USDCx trade there, and whether the user chose them is not knowable.
  it("leaves any strategy with a Stacks wallet untouched", () => {
    expect(planStaleTokenRepair({ tokenIn: "STX" }, ["base:mainnet", "stacks:mainnet"]))
      .toEqual({ action: "skip", reason: "has_stacks_wallet" });
  });

  it("skips strategies with no resolvable wallets or nothing stale", () => {
    expect(planStaleTokenRepair({ tokenIn: "STX" }, [])).toEqual({ action: "skip", reason: "no_wallets" });
    expect(planStaleTokenRepair({ tokenIn: "ETH" }, ["base:mainnet"]))
      .toEqual({ action: "skip", reason: "nothing_stale" });
  });
});
