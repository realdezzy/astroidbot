import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { FaktoryDEXService } from "../src/services/dex/faktory.js";
import { ConfigManager } from "../src/config.js";

// Mock the Faktory SDK
vi.mock("@faktoryfun/core-sdk", () => {
  return {
    FaktorySDK: vi.fn().mockImplementation(() => {
      return {
        getVerifiedTokens: vi.fn().mockResolvedValue({
          count: 1,
          results: [
            {
              tokenContract: "SP14FSJX1Q9EV6RA2GP2WZ3RNK6DX7057QNXC4Z9B.lunacat-nebula-nibs-faktory",
              symbol: "LUNACAT",
              name: "LunaCat",
              decimals: 6,
              dexContract: "SP14FSJX1Q9EV6RA2GP2WZ3RNK6DX7057QNXC4Z9B.lunacat-nebula-nibs-faktory-dex",
            },
          ],
        }),
        getIn: vi.fn().mockResolvedValue({
          value: {
            value: {
              "tokens-out": {
                value: "5136800083133",
              },
            },
          },
        }),
        getOut: vi.fn().mockResolvedValue({
          value: {
            value: {
              "stx-out": {
                value: "9800000",
              },
            },
          },
        }),
        getToken: vi.fn().mockResolvedValue({
          data: {
            price: 0.000002,
          },
        }),
        getBuyParams: vi.fn().mockResolvedValue({
          contractAddress: "SP14FSJX1Q9EV6RA2GP2WZ3RNK6DX7057QNXC4Z9B",
          contractName: "lunacat-nebula-nibs-faktory-dex",
          functionName: "buy",
          functionArgs: [],
          postConditions: [],
        }),
        getSellParams: vi.fn().mockResolvedValue({
          contractAddress: "SP14FSJX1Q9EV6RA2GP2WZ3RNK6DX7057QNXC4Z9B",
          contractName: "lunacat-nebula-nibs-faktory-dex",
          functionName: "sell",
          functionArgs: [],
          postConditions: [],
        }),
      };
    }),
  };
});

describe("FaktoryDEXService Unit Tests", () => {
  let service: FaktoryDEXService;

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
      FaktoryDEXService.initialize();
    } catch {}
    service = FaktoryDEXService.getInstance();
  });

  it("should get swappable tokens", async () => {
    const tokens = await service.getSwappableTokens(true);
    expect(tokens.length).toBe(1);
    expect(tokens[0]!.symbol).toBe("LUNACAT");
  });

  it("should check route", async () => {
    await service.getSwappableTokens(true);
    const has = await service.hasRoute("STX", "LUNACAT");
    expect(has).toBe(true);
  });

  it("should get buy quote", async () => {
    await service.getSwappableTokens(true);
    const quote = await service.getQuote("STX", "LUNACAT", 10);
    expect(quote.amountOut).toBe(5136800.083133);
  });

  it("should get sell quote", async () => {
    await service.getSwappableTokens(true);
    const quote = await service.getQuote("LUNACAT", "STX", 10);
    expect(quote.amountOut).toBe(9.8);
  });

  it("should build swap payload", async () => {
    await service.getSwappableTokens(true);
    const payload = await service.buildSwapPayload("STX", "LUNACAT", 10, 4000000, "SPMYF9RSJWA9SGDM25ARH13C3HSEM93EWDPE07J2");
    expect(payload).not.toBeNull();
    expect(payload!.contractAddress).toBe("SP14FSJX1Q9EV6RA2GP2WZ3RNK6DX7057QNXC4Z9B");
  });
});
