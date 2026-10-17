import { describe, it, expect } from "vitest";
import { safeValidateStrategyConfig } from "../../../src/services/strategy/configValidation.js";

describe("strategy config validation", () => {
  // z.coerce.boolean() read the string "false" as true, so a client that sent
  // form or chat values switched AI on by asking to switch it off.
  it.each([
    ["false", false],
    ["0", false],
    [false, false],
    ["true", true],
    ["1", true],
    [true, true],
  ])("parses useAI=%j as %j", (input, expected) => {
    for (const type of ["portfolio_rebalance", "grid"]) {
      const result = safeValidateStrategyConfig(type, { useAI: input });
      expect(result.success).toBe(true);
      expect(result.data?.useAI).toBe(expected);
    }
  });

  it("rejects a useAI value that is not a boolean spelling", () => {
    expect(safeValidateStrategyConfig("grid", { useAI: "maybe" }).success).toBe(false);
  });

  // Schema defaults are persisted at creation and can only name one chain.
  // These named Stacks, so a Base strategy saved without tokens never routed.
  it("leaves unset token legs unset, for the strategy to fill from its chain", () => {
    for (const type of ["dca", "twap"]) {
      const result = safeValidateStrategyConfig(type, {});
      expect(result.success).toBe(true);
      expect(result.data).not.toHaveProperty("tokenIn");
      expect(result.data).not.toHaveProperty("tokenOut");
    }
    for (const type of ["grid", "mean_reversion", "breakout"]) {
      const result = safeValidateStrategyConfig(type, {});
      expect(result.success).toBe(true);
      expect(result.data).not.toHaveProperty("tokenPair");
    }
  });

  it("keeps explicitly configured token legs", () => {
    const result = safeValidateStrategyConfig("dca", { tokenIn: "ETH", tokenOut: "USDC" });
    expect(result.data).toMatchObject({ tokenIn: "ETH", tokenOut: "USDC" });
  });
});
