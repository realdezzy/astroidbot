import {
  getNextNonce,
  validateMaxOutbound,
  shouldContinuePolling,
} from "../src/services/transaction.js";

describe("TransactionService (from src/)", () => {
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
        shouldContinuePolling("aborted_by_response", 1, 20)
      ).toBe(false);
      expect(
        shouldContinuePolling("aborted_by_post_condition", 1, 20)
      ).toBe(false);
    });

    it("continues on pending", () => {
      expect(shouldContinuePolling("pending", 1, 20)).toBe(true);
    });

    it("stops after max attempts", () => {
      expect(shouldContinuePolling("pending", 20, 20)).toBe(false);
    });
  });
});
