import {
  getNextNonce,
  validateMaxOutbound,
  shouldContinuePolling,
  parseTokenAmount,
  TransactionService,
} from "../src/services/transaction.js";
import { ConfigManager } from "../src/config.js";
import { beforeAll, vi } from "vitest";

describe("TransactionService (from src/)", () => {
  beforeAll(() => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    process.env.TELEGRAM_WEBHOOK_URL = "https://example.com/webhook";
    ConfigManager.load();
  });

  describe("Nonce management", () => {
    let nonceCache: Record<string, number> = {};

    beforeEach(() => {
      nonceCache = {};
    });

    it("starts at 0 for new address", () => {
      expect(getNextNonce(nonceCache, "SP1")).toBe(0);
    });

    it("increments locally after first nonce", () => {
      getNextNonce(nonceCache, "SP1");
      expect(getNextNonce(nonceCache, "SP1")).toBe(1);
      expect(getNextNonce(nonceCache, "SP1")).toBe(2);
    });

    it("tracks nonces independently per address", () => {
      getNextNonce(nonceCache, "SP1");
      getNextNonce(nonceCache, "SP1");
      expect(getNextNonce(nonceCache, "SP2")).toBe(0);
      expect(getNextNonce(nonceCache, "SP1")).toBe(2);
    });

    it("starts at provided initial value", () => {
      expect(getNextNonce(nonceCache, "SP1", 5)).toBe(5);
      expect(getNextNonce(nonceCache, "SP1")).toBe(6);
    });

    it("clears on conflict (delete from cache)", () => {
      getNextNonce(nonceCache, "SP1");
      getNextNonce(nonceCache, "SP1");
      delete nonceCache["SP1"];
      expect(getNextNonce(nonceCache, "SP1")).toBe(0);
    });
  });

  describe("Post-condition safety", () => {
    it("permits amount within limit", () => {
      expect(validateMaxOutbound(100, 150)).toBe(true);
    });

    it("rejects amount above limit", () => {
      expect(validateMaxOutbound(200, 150)).toBe(false);
    });

    it("permits equal amount", () => {
      expect(validateMaxOutbound(100, 100)).toBe(true);
    });
  });

  describe("Confirmation polling", () => {
    it("stops on success", () => {
      expect(shouldContinuePolling("success", 1, 20)).toBe(false);
    });

    it("stops on abort", () => {
      expect(
        shouldContinuePolling("abort_by_response", 1, 20)
      ).toBe(false);
      expect(
        shouldContinuePolling("abort_by_post_condition", 1, 20)
      ).toBe(false);
    });

    it("continues on pending", () => {
      expect(shouldContinuePolling("pending", 1, 20)).toBe(true);
    });

    it("stops after max attempts", () => {
      expect(shouldContinuePolling("pending", 20, 20)).toBe(false);
    });
  });

  describe("Float-free amount parsing", () => {
    it("converts numbers accurately", () => {
      expect(parseTokenAmount(1.234567, 6)).toBe(1234567n);
      expect(parseTokenAmount(0.0001, 6)).toBe(100n);
      expect(parseTokenAmount(10, 6)).toBe(10000000n);
    });

    it("converts strings accurately", () => {
      expect(parseTokenAmount("1.234567", 6)).toBe(1234567n);
      expect(parseTokenAmount("0.000005", 6)).toBe(5n);
      expect(parseTokenAmount("100", 6)).toBe(100000000n);
    });

    it("handles different decimals", () => {
      expect(parseTokenAmount(12.345, 3)).toBe(12345n);
      expect(parseTokenAmount("0.000000001", 9)).toBe(1n);
    });
  });

  describe("Post-condition normalization", () => {
    it("preserves non-STX post-conditions", () => {
      const txService = TransactionService.getInstance();
      const action = {
        tokenIn: "SOME-TOKEN",
        tokenOut: "STX",
        amountIn: 100,
        direction: "SELL" as const,
        reason: "Test",
      };
      const dummyPostCondition = {
        conditionType: 1, // Fungible condition type
        principal: {},
        amount: 100n,
      };

      const result = (txService as any).normalizePostConditions(
        action,
        "SP1",
        "SP2",
        10000n,
        [dummyPostCondition]
      );

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(dummyPostCondition);
    });

    it("replaces STX post-condition for STX inputs", () => {
      const txService = TransactionService.getInstance();
      const action = {
        tokenIn: "STX",
        tokenOut: "SOME-TOKEN",
        amountIn: 0.5,
        direction: "BUY" as const,
        reason: "Test",
      };
      // Simulating a dummy incorrect/empty/SentEq 0 post condition
      const dummyIncorrectSTXCondition = {
        conditionType: 0, // STX condition type
        principal: {},
        amount: 0n,
      };

      const result = (txService as any).normalizePostConditions(
        action,
        "SPMYF9RSJWA9SGDM25ARH13C3HSEM93EWDPE07J2",
        "SP2",
        3816n,
        [dummyIncorrectSTXCondition]
      );

      // It should replace the condition with a proper LessEqual condition for 500,000 + 3,816 = 503,816
      expect(result).toHaveLength(1);
      expect(result[0].conditionType).toBe(0);
      expect(result[0].amount).toBe(503816n);
    });
  });

  describe("confirmTransaction duplicate prevention", () => {
    it("should prevent duplicate concurrent confirmation polls for the same txId", async () => {
      const txService = TransactionService.getInstance();
      
      // Mock fetchTransactionStatus to simulate a pending transaction
      const fetchSpy = vi.spyOn(txService as any, "fetchTransactionStatus")
        .mockResolvedValue({ status: "pending" });

      // Override sleep to resolve immediately and speed up the test
      const sleepSpy = vi.spyOn(txService as any, "sleep").mockResolvedValue(undefined);

      // Trigger first poll
      const firstPollPromise = txService.confirmTransaction("0xtesttxid123", 123);

      // Trigger second poll on same txId while first is running
      const secondPollPromise = txService.confirmTransaction("0xtesttxid123", 123);

      // The second poll should skip and return false immediately
      const secondPollResult = await secondPollPromise;
      expect(secondPollResult).toBe(false);

      // Wait for first poll to complete
      await firstPollPromise;

      // Cleanup
      fetchSpy.mockRestore();
      sleepSpy.mockRestore();
    });
  });
});
