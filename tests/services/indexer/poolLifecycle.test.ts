import { describe, expect, it } from "vitest";
import { PoolLifecycleEngine } from "../../../src/services/indexer/discovery/poolLifecycle.js";

describe("PoolLifecycleEngine", () => {
  it("marks a newly created pool without swaps as DISCOVERED", () => {
    const state = PoolLifecycleEngine.evaluateState({
      createdAt: new Date(),
    });
    expect(state).toBe("DISCOVERED");
  });

  it("marks a pool with recent swaps as ACTIVE", () => {
    const state = PoolLifecycleEngine.evaluateState({
      createdAt: new Date(Date.now() - 86400000),
      lastSwapAt: new Date(Date.now() - 3600000),
      liquidityUsd: 50000,
    });
    expect(state).toBe("ACTIVE");
  });

  it("marks a pool inactive after 24 hours of no trades", () => {
    const state = PoolLifecycleEngine.evaluateState({
      createdAt: new Date(Date.now() - 86400000 * 5),
      lastSwapAt: new Date(Date.now() - 86400000 * 2),
      liquidityUsd: 50000,
    });
    expect(state).toBe("INACTIVE");
  });
});
