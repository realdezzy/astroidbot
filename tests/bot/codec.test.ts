import { describe, it, expect } from "vitest";
import {
  encodeCallback,
  decodeCallback,
  shortenChainId,
  expandChainId,
  CALLBACK_DATA_MAX_BYTES,
} from "../../src/bot/callbacks/codec.js";

/**
 * Telegram truncates callback_data past 64 bytes silently — the button renders,
 * the tap fires, and the handler gets a mangled string. Adding a chainId to an
 * existing callback is exactly the change that trips this, so the codec checks
 * length at build time where it's a loud developer error.
 */
describe("callback codec", () => {
  it("round-trips a namespace, action and args", () => {
    const data = encodeCallback("trade", "sel", "base.mainnet", "USDC");
    expect(decodeCallback(data)).toEqual({
      namespace: "trade",
      action: "sel",
      args: ["base.mainnet", "USDC"],
    });
  });

  it("round-trips with no args", () => {
    expect(decodeCallback(encodeCallback("wallet", "new"))).toEqual({
      namespace: "wallet",
      action: "new",
      args: [],
    });
  });

  it("throws rather than silently truncating an over-long payload", () => {
    // Truncation would ship a button that does the wrong thing.
    expect(() => encodeCallback("trade", "sel", "x".repeat(80))).toThrow(/over Telegram's/);
  });

  it("accepts a payload exactly at the limit", () => {
    const filler = "y".repeat(CALLBACK_DATA_MAX_BYTES - "ns|act|".length);
    const data = encodeCallback("ns", "act", filler);
    expect(Buffer.byteLength(data, "utf8")).toBe(CALLBACK_DATA_MAX_BYTES);
  });

  it("counts bytes, not characters, so multi-byte symbols can't sneak over", () => {
    // A 40-char emoji string is 160 bytes; a naive .length check would pass it.
    expect(() => encodeCallback("ns", "act", "🚀".repeat(40))).toThrow(/over Telegram's/);
  });

  it("rejects a segment containing the separator", () => {
    expect(() => encodeCallback("trade", "sel", "a|b")).toThrow(/reserved separator/);
  });

  it("returns null for data not in this scheme, so legacy handlers still see it", () => {
    expect(decodeCallback("action:trade_token_in_select:STX")).toBeNull();
    expect(decodeCallback("home")).toBeNull();
  });

  describe("chainId shortening", () => {
    it("round-trips mainnet ids", () => {
      expect(expandChainId(shortenChainId("base:mainnet"))).toBe("base:mainnet");
      expect(expandChainId(shortenChainId("stacks:mainnet"))).toBe("stacks:mainnet");
      expect(expandChainId(shortenChainId("celo:mainnet"))).toBe("celo:mainnet");
    });

    it("round-trips testnet ids", () => {
      expect(expandChainId(shortenChainId("base:sepolia"))).toBe("base:sepolia");
      expect(expandChainId(shortenChainId("solana:devnet"))).toBe("solana:devnet");
    });

    it("actually saves bytes on the common case", () => {
      expect(shortenChainId("base:mainnet")).toBe("base");
      expect(shortenChainId("base:sepolia")).toBe("base.sepolia");
    });

    it("keeps a chain picker payload well inside the limit", () => {
      for (const chainId of ["base:mainnet", "celo:mainnet", "stacks:mainnet", "solana:devnet"]) {
        const data = encodeCallback("wallet", "new", shortenChainId(chainId));
        expect(Buffer.byteLength(data, "utf8")).toBeLessThanOrEqual(CALLBACK_DATA_MAX_BYTES);
      }
    });
  });
});
