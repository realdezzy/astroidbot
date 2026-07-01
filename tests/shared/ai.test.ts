import { describe, it, expect } from "vitest";
import { AI_MODES, AI_ACTIONS, AI_CONTEXTS, AI_CACHE_TTL } from "../../shared/ai.js";

describe("Shared AI configuration and cache TTLs", () => {
  it("should have correct modes and actions lists", () => {
    expect(AI_MODES).toContain("off");
    expect(AI_MODES).toContain("autonomous");
    expect(AI_MODES).toContain("advisor");

    expect(AI_ACTIONS).toContain("trade");
    expect(AI_ACTIONS).toContain("settings");
  });

  it("should define cache TTL values for contexts", () => {
    for (const ctx of AI_CONTEXTS) {
      expect(AI_CACHE_TTL[ctx]).toBeGreaterThan(0);
    }
  });
});
