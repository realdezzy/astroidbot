import { describe, it, expect, beforeAll } from "vitest";
import { ConfigManager } from "../../../src/config.js";
import { defineEvmChain, parseCustomEvmChains } from "../../../src/services/chains/descriptors/defineEvmChain.js";

/**
 * The EVM adapter must be configurable enough that adding a chain is data, and
 * strict enough that bad data fails at startup rather than as a silent
 * "no route found" months later.
 */
describe("EvmChainAdapter configuration", () => {
  let EvmChainAdapter: typeof import("../../../src/services/chains/evm/evmChainAdapter.js").EvmChainAdapter;

  const validSpec = {
    chainId: "test:mainnet",
    displayName: "Test Chain",
    id: 9999,
    rpcUrl: "https://rpc.example.com",
    nativeSymbol: "TEST",
    stableSymbol: "USDC",
    explorerBaseUrl: "https://explorer.example.com",
  };

  beforeAll(async () => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    ConfigManager.load();
    ({ EvmChainAdapter } = await import("../../../src/services/chains/evm/evmChainAdapter.js"));
  });

  it("rejects a malformed address at construction rather than at first quote", () => {
    // Base's mainnet QuoterV2 was 39 hex chars for months. viem threw inside
    // the per-fee-tier catch, so every pair reported "no route" with nothing
    // in the logs — a dead chain that looked like an empty market.
    const badDescriptor = defineEvmChain({
      ...validSpec,
      dex: {
        name: "UniswapV3",
        quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76" as `0x${string}`, // 39 chars
        swapRouter: "0x2626664c2603336E57B271c5C0b26F421741e481",
        feeTiers: [500],
      },
    });

    expect(() => new EvmChainAdapter(badDescriptor)).toThrow(/malformed EVM address/);
  });

  it("accepts a well-formed descriptor", () => {
    const good = defineEvmChain({
      ...validSpec,
      dex: {
        name: "UniswapV3",
        quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
        swapRouter: "0x2626664c2603336E57B271c5C0b26F421741e481",
        feeTiers: [500, 3000],
      },
    });
    const adapter = new EvmChainAdapter(good);
    expect(adapter.chainId()).toBe("test:mainnet");
    expect(adapter.chainFamily).toBe("evm");
    expect(adapter.nativeSymbol).toBe("TEST");
  });

  it("defaults to EOA custody so a chain no bundler serves is still usable", () => {
    // If ERC-4337 were required, "EVM support" would really mean "support for
    // the chains Pimlico happens to serve".
    const d = defineEvmChain(validSpec);
    expect(d.evm?.custody).toBe("eoa");
    expect(() => new EvmChainAdapter(d)).not.toThrow();
  });

  it("refuses erc4337 custody with no bundler configured", () => {
    expect(() =>
      defineEvmChain({ ...validSpec, custody: "erc4337" })
    ).toThrow(/no bundlerSlug/);
  });

  it("derives tradability from whether a DEX is configured", () => {
    // A brand-new network with no router yet is still useful for wallets,
    // balances and discovery — it simply cannot be routed through.
    expect(defineEvmChain(validSpec).tradable).toBe(false);
    expect(
      defineEvmChain({
        ...validSpec,
        dex: {
          name: "UniswapV3",
          quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
          swapRouter: "0x2626664c2603336E57B271c5C0b26F421741e481",
          feeTiers: [500],
        },
      }).tradable
    ).toBe(true);
  });

  it("builds working explorer URLs", () => {
    const d = defineEvmChain(validSpec);
    expect(d.explorerTxUrl("0xabc")).toBe("https://explorer.example.com/tx/0xabc");
    expect(d.explorerAddressUrl("0xdef")).toBe("https://explorer.example.com/address/0xdef");
  });
});

describe("CUSTOM_EVM_CHAINS parsing", () => {
  it("returns nothing for an empty value", () => {
    expect(parseCustomEvmChains(undefined)).toEqual([]);
    expect(parseCustomEvmChains("")).toEqual([]);
    expect(parseCustomEvmChains("   ")).toEqual([]);
  });

  it("parses a well-formed chain spec", () => {
    const chains = parseCustomEvmChains(
      JSON.stringify([
        {
          chainId: "arc:mainnet",
          displayName: "ARC",
          id: 12345,
          rpcUrl: "https://rpc.arc.example",
          nativeSymbol: "ARC",
          stableSymbol: "USDC",
        },
      ])
    );
    expect(chains).toHaveLength(1);
    expect(chains[0]!.chainId).toBe("arc:mainnet");
    expect(chains[0]!.family).toBe("evm");
    // No DEX configured, so listable but not tradable.
    expect(chains[0]!.tradable).toBe(false);
  });

  it("throws on malformed JSON rather than skipping the chain", () => {
    // A chain that silently fails to load is indistinguishable from one that
    // was never requested.
    expect(() => parseCustomEvmChains("{not json")).toThrow(/not valid JSON/);
  });

  it("throws when a required field is missing, naming the field and index", () => {
    expect(() =>
      parseCustomEvmChains(JSON.stringify([{ chainId: "x:mainnet", displayName: "X" }]))
    ).toThrow(/\[0\] is missing required field "id"/);
  });

  it("requires an array", () => {
    expect(() => parseCustomEvmChains('{"chainId":"x"}')).toThrow(/must be a JSON array/);
  });
});
