import { describe, it, expect, vi, beforeEach } from "vitest";
import { CandleService } from "../../../src/services/quant/candleService.js";

const mockFindFirst = vi.fn();
const mockUpdate = vi.fn();
const mockCreate = vi.fn();
const mockFindMany = vi.fn();
const mockCreateMany = vi.fn();

vi.mock("../../../src/services/db.js", () => {
  return {
    DatabaseService: {
      getInstance: () => ({
        prisma: {
          $transaction: (cb: (tx: unknown) => unknown) => cb({
            candle: {
              findFirst: mockFindFirst,
              update: mockUpdate,
              create: mockCreate,
            }
          }),
          candle: {
            findMany: mockFindMany,
            createMany: mockCreateMany,
          }
        }
      })
    }
  };
});

describe("CandleService", () => {
  const service = CandleService.getInstance();

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rounds periods correctly based on timeframe", () => {
    const ts = new Date("2026-07-02T12:34:56Z").getTime();
    
    const min1 = service.getPeriodStart(ts, "1m");
    expect(min1.getUTCMinutes()).toBe(34);
    expect(min1.getUTCSeconds()).toBe(0);

    const min5 = service.getPeriodStart(ts, "5m");
    expect(min5.getUTCMinutes()).toBe(30);

    const min15 = service.getPeriodStart(ts, "15m");
    expect(min15.getUTCMinutes()).toBe(30);

    const hour1 = service.getPeriodStart(ts, "1h");
    expect(hour1.getUTCMinutes()).toBe(0);
    expect(hour1.getUTCHours()).toBe(12);

    const day1 = service.getPeriodStart(ts, "1d");
    expect(day1.getUTCHours()).toBe(0);
  });

  it("updates existing candle when recording price", async () => {
    mockFindFirst.mockResolvedValue({ id: 1, high: 2.0, low: 1.5, volume: 100 });
    mockUpdate.mockResolvedValue({});

    await service.recordPrice("STX", 2.2, 50);

    expect(mockFindFirst).toHaveBeenCalled();
    expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        high: 2.2,
        volume: 150,
      })
    }));
  });

  it("creates new candle when none exists", async () => {
    mockFindFirst.mockResolvedValue(null);
    mockCreate.mockResolvedValue({});

    await service.recordPrice("STX", 1.8, 50);

    expect(mockFindFirst).toHaveBeenCalled();
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        open: 1.8,
        close: 1.8,
        volume: 50,
      })
    }));
  });

  it("retrieves historical candles correctly", async () => {
    const mockCandles = [
      { id: 1, open: 1.0, high: 1.2, low: 0.9, close: 1.1, volume: 1000, timestamp: new Date() }
    ];
    mockFindMany.mockResolvedValue(mockCandles);

    const candles = await service.getCandles("STX", "5m", 10);
    expect(candles).toHaveLength(1);
    expect(candles[0]).toEqual(expect.objectContaining({
      open: 1.0,
      close: 1.1,
    }));
  });
});
