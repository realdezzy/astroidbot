import { describe, it, expect } from "vitest";
import { parseBlockRangeLimit } from "../../../src/services/indexer/evm/uniswapV3Indexer.js";

/**
 * Provider refusals, verbatim.
 *
 * The Alchemy one is the message that motivated this: it matched none of the
 * reader's substrings, so the range was classified "unknown", the cursor was
 * held so it would be retried, and it was retried forever against a cap that
 * never lifts. Ingestion stopped with nothing above `warn` and a green health
 * endpoint — so these strings are pinned rather than paraphrased.
 */
const ALCHEMY_FREE_TIER =
  "Under the Free tier plan, you can make eth_getLogs requests with up to a 10 " +
  "block range. Based on your parameters, this block range should work: " +
  "[0x30a4365, 0x30a436e]. Upgrade to PAYG for expanded block range.";

describe("parseBlockRangeLimit", () => {
  it("reads the cap Alchemy states in prose", () => {
    expect(parseBlockRangeLimit(ALCHEMY_FREE_TIER)).toBe(10n);
  });

  it("reads a suggested range when no cap is stated in words", () => {
    // 0x30a4365..0x30a436e inclusive is ten blocks.
    expect(
      parseBlockRangeLimit("this block range should work: [0x30a4365, 0x30a436e]")
    ).toBe(10n);
  });

  it("handles a thousands-separated cap", () => {
    expect(parseBlockRangeLimit("you may query up to 10,000 blocks per request")).toBe(10_000n);
  });

  it("returns null when the provider states no number", () => {
    // The caller falls back to halving, which is what it did before.
    expect(parseBlockRangeLimit("query returned more than 10000 results")).toBeNull();
    expect(parseBlockRangeLimit("block range is too large")).toBeNull();
    expect(parseBlockRangeLimit("")).toBeNull();
  });

  it("never returns a non-positive window", () => {
    // A zero window would stall the chunker outright.
    expect(parseBlockRangeLimit("up to 0 blocks")).toBeNull();
    expect(parseBlockRangeLimit("range should work: [0x20, 0x10]")).toBeNull();
  });
});
