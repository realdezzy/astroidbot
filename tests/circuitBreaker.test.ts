import { describe, it, expect } from "vitest";
import { CircuitBreaker, CircuitState } from "../src/utils/circuitBreaker.js";

describe("CircuitBreaker Unit Tests", () => {
  it("should trip to OPEN after threshold of consecutive failures", async () => {
    const breaker = new CircuitBreaker("test-breaker", { failureThreshold: 3 });
    expect(breaker.getState()).toBe(CircuitState.CLOSED);

    const failFn = () => Promise.reject(new Error("system error"));

    // 1st failure
    await expect(breaker.execute(failFn)).rejects.toThrow("system error");
    expect(breaker.getState()).toBe(CircuitState.CLOSED);

    // 2nd failure
    await expect(breaker.execute(failFn)).rejects.toThrow("system error");
    expect(breaker.getState()).toBe(CircuitState.CLOSED);

    // 3rd failure - should trip
    await expect(breaker.execute(failFn)).rejects.toThrow("system error");
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Subsequent call should immediately fail due to open breaker
    await expect(breaker.execute(() => Promise.resolve("ok"))).rejects.toThrow("Circuit breaker for test-breaker is OPEN");
  });

  it("should not count business errors (Can't find route / No route found) as failures", async () => {
    const breaker = new CircuitBreaker("test-breaker", { failureThreshold: 2 });
    expect(breaker.getState()).toBe(CircuitState.CLOSED);

    const businessErrorFn = () => Promise.reject(new Error("Can't find route"));

    // Execute business error fn multiple times
    await expect(breaker.execute(businessErrorFn)).rejects.toThrow("Can't find route");
    await expect(breaker.execute(businessErrorFn)).rejects.toThrow("Can't find route");
    await expect(breaker.execute(businessErrorFn)).rejects.toThrow("Can't find route");

    // State should still be CLOSED
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });
});
