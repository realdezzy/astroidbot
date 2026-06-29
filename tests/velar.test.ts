import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { VelarDEXService } from "../src/services/dex/velar.js";
import { ConfigManager } from "../src/config.js";

// Mock the Velar SDK
vi.mock("@velarprotocol/velar-sdk", () => {
  return {
    VelarSDK: vi.fn().mockImplementation(() => {
      return {
        init: vi.fn().mockResolvedValue(undefined),
        setBlockChainApiUrl: vi.fn(),
        getSwapInstance: vi.fn().mockResolvedValue({
          buildPoolInfo: vi.fn().mockResolvedValue({
            routes: [{ id: "mock-route" }],
          }),
          getComputedAmount: vi.fn().mockResolvedValue({
            valid: true,
            value: 21319.36,
          }),
          swap: vi.fn().mockResolvedValue({
            contractAddress: "SP20X3DC5R091J8B6YPQT638J8NR1W83KN6TN5BJY",
            contractName: "path-apply_staging",
            functionName: "apply",
            functionArgs: [],
            postConditions: [],
          }),
        }),
      };
    }),
    getTokensMeta: vi.fn().mockResolvedValue([
      {
        contractAddress: "SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx",
        symbol: "STX",
        name: "wstx",
        tokenDecimalNum: 1000000,
        price: "1.5",
      },
      {
        contractAddress: "SP1AY6K3PQV5MRT6R4S671NWW2FRVPKM0BR162CT6.leo-token",
        symbol: "LEO",
        name: "leo-token",
        tokenDecimalNum: 1000000,
        price: "0.00007",
      },
    ]),
  };
});

describe("VelarDEXService Unit Tests", () => {
  let service: VelarDEXService;

  beforeAll(() => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    process.env.TELEGRAM_WEBHOOK_URL = "https://example.com/webhook";
    process.env.STACKS_API_URL = "https://api.hiro.so";
    ConfigManager.load();
  });

  beforeEach(() => {
    try {
      VelarDEXService.initialize();
    } catch {}
    service = VelarDEXService.getInstance();
  });

  it("should get swappable tokens", async () => {
    const tokens = await service.getSwappableTokens(true);
    expect(tokens.length).toBe(2);
    expect(tokens[0]!.symbol).toBe("STX");
    expect(tokens[1]!.symbol).toBe("LEO");
  });

  it("should check route", async () => {
    await service.getSwappableTokens(true);
    const has = await service.hasRoute("STX", "LEO");
    expect(has).toBe(true);
  });

  it("should get quote", async () => {
    await service.getSwappableTokens(true);
    const quote = await service.getQuote("STX", "LEO", 10);
    expect(quote.amountOut).toBe(21319.36);
    expect(quote.priceImpact).toBeDefined();
  });

  it("should build swap payload", async () => {
    await service.getSwappableTokens(true);
    const payload = await service.buildSwapPayload("STX", "LEO", 10, 20000, "SPMYF9RSJWA9SGDM25ARH13C3HSEM93EWDPE07J2");
    expect(payload).not.toBeNull();
    expect(payload!.contractAddress).toBe("SP20X3DC5R091J8B6YPQT638J8NR1W83KN6TN5BJY");
  });
});
