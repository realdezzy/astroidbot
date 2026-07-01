import { describe, it, expect } from "vitest";
import { DEFAULTS } from "../../shared/constants.js";

describe("Shared constants config defaults", () => {
  it("should contain all expected default configurations", () => {
    expect(DEFAULTS.pollIntervalSeconds).toBe(60);
    expect(DEFAULTS.dryRun).toBe(true);
    expect(DEFAULTS.bcryptRounds).toBe(12);
    expect(DEFAULTS.dustThresholdUsd).toBe(0.50);
    expect(DEFAULTS.defaultSlippageBps).toBe(100);
    expect(DEFAULTS.defaultMaxPositionPct).toBe(25);
    expect(DEFAULTS.defaultRebalanceThreshold).toBe(2);
    expect(DEFAULTS.defaultPort).toBe(8006);
    expect(DEFAULTS.rateLimitMax).toBe(100);
  });
});
