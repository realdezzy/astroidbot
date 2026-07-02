import { describe, it, expect, vi, beforeEach } from "vitest";
import { PoolStatsService } from "../../../src/services/quant/poolStatsService.js";

const mockCreate = vi.fn();
const mockFindMany = vi.fn();

vi.mock("../../../src/services/db.js", () => {
  return {
    DatabaseService: {
      getInstance: () => ({
        prisma: {
          poolStatsHistory: {
            create: mockCreate,
            findMany: mockFindMany,
          }
        }
      })
    }
  };
});

describe("PoolStatsService", () => {
  const service = PoolStatsService.getInstance();

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("persists pool stats correctly", async () => {
    mockCreate.mockResolvedValue({});

    await service.recordPoolStats("STX", {
      liquidityUsd: 100000,
      tvlUsd: 200000,
      volume24hUsd: 50000,
      holderConcentration: 0.45,
      netWhaleFlowUsd: 2000,
    });

    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        token: "STX",
        liquidityUsd: 100000,
        holderConcentration: 0.45,
      })
    }));
  });

  it("detects if liquidity is draining when current liquidity is more than 20% below average", async () => {
    const now = Date.now();
    const oneHourAgo = new Date(now - 1 * 60 * 60 * 1000);
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000);
    const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000);
    const fourDaysAgo = new Date(now - 4 * 24 * 60 * 60 * 1000);

    // Historical average = 100k, Current average = 70k (30% drop -> should return true)
    mockFindMany.mockResolvedValue([
      { liquidityUsd: 70000, timestamp: oneHourAgo },
      { liquidityUsd: 70000, timestamp: twoHoursAgo },
      { liquidityUsd: 100000, timestamp: threeDaysAgo },
      { liquidityUsd: 100000, timestamp: fourDaysAgo },
    ]);

    const isDraining = await service.isLiquidityDraining("STX");
    expect(isDraining).toBe(true);
  });

  it("does not report liquidity drain if current liquidity remains steady", async () => {
    const now = Date.now();
    const oneHourAgo = new Date(now - 1 * 60 * 60 * 1000);
    const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000);

    // Current = 95k, Historical = 100k (only 5% drop -> should return false)
    mockFindMany.mockResolvedValue([
      { liquidityUsd: 95000, timestamp: oneHourAgo },
      { liquidityUsd: 100000, timestamp: threeDaysAgo },
      { liquidityUsd: 100000, timestamp: new Date(now - 4 * 24 * 60 * 60 * 1000) },
    ]);

    const isDraining = await service.isLiquidityDraining("STX");
    expect(isDraining).toBe(false);
  });

  it("detects volume spike when recent volume exceeds double the baseline", async () => {
    const now = Date.now();
    const oneHourAgo = new Date(now - 1 * 60 * 60 * 1000);
    const twelveHoursAgo = new Date(now - 12 * 60 * 60 * 1000);

    // Recent = 100k, Historical = 30k (more than 2x -> spike is true)
    mockFindMany.mockResolvedValue([
      { volume24hUsd: 100000, timestamp: oneHourAgo },
      { volume24hUsd: 30000, timestamp: twelveHoursAgo },
      { volume24hUsd: 30000, timestamp: new Date(now - 24 * 60 * 60 * 1000) },
    ]);

    const trend = await service.getVolumeTrend("STX");
    expect(trend.spike).toBe(true);
    expect(trend.ratio).toBeCloseTo(3.33, 1);
  });
});
