import { describe, it, expect } from "vitest";
import { BUILT_IN_DESCRIPTORS, findDescriptor } from "../../../src/services/chains/descriptors/index.js";

/**
 * Arc mainnet — Circle's USDC-gas L1, chain 5042.
 *
 * This file used to have a sibling comment in `arc.ts` explaining why there
 * was deliberately no `arc:mainnet`: the network was testnet-only and an entry
 * with invented parameters would have been accepted by ENABLED_CHAINS and
 * failed as unexplained broadcast errors. Mainnet is live now, so the entry
 * exists — and every address in it was read back off chain 5042 rather than
 * copied from a listing, because Arc is a chain where that distinction bites:
 * the canonical Uniswap v3 factory address (0x1F98…F984) holds a contract on
 * Arc that is not the v3 factory, and Arc's v2 router is byte-identical to
 * Robinhood's v3 factory.
 */
describe("Arc mainnet descriptor", () => {
  const arc = findDescriptor("arc:mainnet");

  it("is in the built-in catalogue", () => {
    expect(arc).toBeDefined();
    expect(BUILT_IN_DESCRIPTORS).toContain(arc);
  });

  it("describes EIP-155 chain 5042", () => {
    expect(arc!.evm!.id).toBe(5042);
  });

  it("is tradable, because Uniswap routes on it", () => {
    expect(arc!.tradable).toBe(true);
  });

  it("prices in USDC, which is also the gas token", () => {
    expect(arc!.nativeSymbol).toBe("USDC");
    expect(arc!.stableSymbol).toBe("USDC");
  });

  it("keeps 18 native decimals, because gas is still denominated in wei", () => {
    // Arc scales USDC up to 18 decimals for gas accounting even though the
    // ERC-20 view of the same balance is 6. eth_getBalance returns the
    // 18-decimal figure, so this is what formats a wallet balance.
    expect(arc!.nativeDecimals).toBe(18);
  });

  it("states its block time, so the indexer's reorg margin is measured in seconds", () => {
    // Measured: 25,364 s across 50,000 blocks, and 2,537 s across 5,000.
    // Without this the global 12-block confirmation depth would be ~6 seconds
    // of reorg protection here.
    expect(arc!.indexer?.blockTimeSeconds).toBeCloseTo(0.507, 3);
  });

  it("links transactions to explorer.arc.io", () => {
    expect(arc!.explorerTxUrl("0xabc")).toBe("https://explorer.arc.io/tx/0xabc");
  });

  it("declares the ERC-20 view of the native asset rather than a wrapped one", () => {
    // There is no wrapped native on Arc: SwapRouter02.WETH9() points at a
    // 53-byte stub and Uniswap's own SDK marks the chain
    // WETH_NOT_SUPPORTED_ON_CHAIN. USDC at 0x3600… is not a wrapper — it is
    // the same balance as eth_getBalance, surfaced at 6 decimals. Setting
    // `wrappedNative` would make the provider bracket every swap with
    // deposit/withdraw calls that do not exist, at 18 decimals for a
    // 6-decimal token.
    expect(arc!.evm!.wrappedNative).toBeUndefined();
    expect(arc!.evm!.nativeErc20).toEqual({
      address: "0x3600000000000000000000000000000000000000",
      decimals: 6,
    });
  });

  it("keeps the testnet entry alongside it", () => {
    expect(findDescriptor("arc:testnet")).toBeDefined();
  });
});
