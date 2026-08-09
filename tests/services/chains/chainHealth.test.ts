import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * A chain whose RPC has been failing must be visible without reading logs.
 *
 * Circuit breakers already stopped one dead chain degrading the others; what
 * was missing was anyone finding out it had happened. The symptom users see —
 * "no route" on every pair — is indistinguishable from a chain nobody trades
 * on, so an outage could persist for as long as nobody happened to look.
 */

const notifications: { userId: number; title: string; type: string }[] = [];

vi.mock("../../../src/services/notificationService.js", () => ({
  NotificationService: {
    getInstance: () => ({
      send: vi.fn(async (n: { userId: number; title: string; type: string }) => {
        notifications.push(n);
      }),
    }),
  },
}));

vi.mock("../../../src/services/db.js", () => ({
  DatabaseService: {
    getInstance: () => ({
      prisma: { user: { findMany: vi.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]) } },
    }),
  },
}));

const registered: { chainId: string; displayName: string }[] = [];
vi.mock("../../../src/services/chains/chainAdapterRegistry.js", () => ({
  ChainAdapterRegistry: { getInstance: () => ({ list: () => registered }) },
}));

const { ChainHealthMonitor } = await import("../../../src/services/chains/chainHealth.js");

const CHAIN = "celo:mainnet";

/** Lets the fire-and-forget alert path settle before asserting on it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("ChainHealthMonitor", () => {
  let monitor: InstanceType<typeof ChainHealthMonitor>;

  beforeEach(() => {
    notifications.length = 0;
    registered.length = 0;
    registered.push({ chainId: CHAIN, displayName: "Celo" });
    monitor = ChainHealthMonitor.getInstance();
    monitor.reset();
  });

  it("tolerates a single failure without calling the chain unhealthy", async () => {
    // One failed call is an RPC hiccup. Alerting on it trains people to ignore
    // the alert, which costs more than the outage it was meant to catch.
    monitor.recordFailure(CHAIN, new Error("timeout"));
    await settle();

    expect(monitor.healthy(CHAIN)).toBe(true);
    expect(notifications).toHaveLength(0);
  });

  it("alerts every admin once a chain has failed repeatedly", async () => {
    for (let i = 0; i < 3; i++) monitor.recordFailure(CHAIN, new Error("ECONNREFUSED"));
    await settle();

    expect(monitor.healthy(CHAIN)).toBe(false);
    expect(notifications.map((n) => n.userId)).toEqual([1, 2]);
    expect(notifications[0]!.title).toContain(CHAIN);
  });

  it("does not re-alert while the outage continues", async () => {
    // An outage lasts hours and every tick touches the chain. Without the
    // cooldown the first hour is several hundred identical messages.
    for (let i = 0; i < 20; i++) monitor.recordFailure(CHAIN, new Error("ECONNREFUSED"));
    await settle();

    expect(notifications).toHaveLength(2); // one per admin, not one per failure
  });

  it("announces recovery, so nobody has to poll to find out", async () => {
    for (let i = 0; i < 3; i++) monitor.recordFailure(CHAIN, new Error("down"));
    await settle();
    notifications.length = 0;

    monitor.recordSuccess(CHAIN);
    await settle();

    expect(monitor.healthy(CHAIN)).toBe(true);
    // Recovery is not rate-limited by the outage's cooldown — it is the
    // message that closes the incident.
    expect(notifications.map((n) => n.title)).toEqual([
      expect.stringContaining("recovered"),
      expect.stringContaining("recovered"),
    ]);
  });

  it("clears the failure streak on the first success", () => {
    monitor.recordFailure(CHAIN, new Error("blip"));
    monitor.recordFailure(CHAIN, new Error("blip"));
    monitor.recordSuccess(CHAIN);
    monitor.recordFailure(CHAIN, new Error("blip"));

    // Two-then-one-then-one is not three consecutive.
    expect(monitor.healthy(CHAIN)).toBe(true);
  });

  it("reports every registered chain, including ones never called", () => {
    // A chain failing at registration is the case most worth seeing, and it
    // has no call history at all.
    registered.push({ chainId: "base:mainnet", displayName: "Base" });

    const snapshot = monitor.snapshot();
    expect(snapshot.map((s) => s.chainId)).toEqual([CHAIN, "base:mainnet"]);
    expect(snapshot.every((s) => s.healthy)).toBe(true);
    // Never called means no breaker exists; reporting CLOSED would read as
    // "fine" when the truth is "never tried".
    expect(snapshot[0]!.breaker).toBeNull();
  });

  it("counts a tracked call's outcome without swallowing it", async () => {
    await monitor.track(CHAIN, async () => "ok");
    await expect(monitor.track(CHAIN, async () => Promise.reject(new Error("boom")))).rejects.toThrow(
      "boom"
    );

    const [snapshot] = monitor.snapshot();
    expect(snapshot!.successes).toBe(1);
    expect(snapshot!.failures).toBe(1);
    expect(snapshot!.lastError).toBe("boom");
  });
});
