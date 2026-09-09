import { describe, it, expect, afterEach } from "vitest";
import { rpcEnvKey, rpcUrlOverride, hasRpcOverride } from "../../../src/services/chains/evm/evmClient.js";

/**
 * Whether a chain is on its public default endpoint is the question the
 * indexer's throughput hangs on, and until now the only way to answer it was
 * to compare the resolved URL against the default string at each call site.
 * That comparison is right until a deployment sets an override to the same
 * value as the default, at which point it silently reports "default".
 */

const KEYS = ["RPC_URL_BASE_MAINNET", "RPC_URL_SOLANA_MAINNET", "RPC_URL_STACKS_MAINNET"];

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

describe("rpcEnvKey", () => {
  it("derives the variable name from the ChainId", () => {
    expect(rpcEnvKey("base:mainnet")).toBe("RPC_URL_BASE_MAINNET");
    expect(rpcEnvKey("solana:mainnet")).toBe("RPC_URL_SOLANA_MAINNET");
  });

  it("folds the hyphen in a hyphenated network name", () => {
    expect(rpcEnvKey("base:sepolia-alt")).toBe("RPC_URL_BASE_SEPOLIA_ALT");
  });
});

describe("hasRpcOverride", () => {
  it("is false when nothing is set", () => {
    expect(hasRpcOverride("base:mainnet")).toBe(false);
  });

  it("is true when the variable is set", () => {
    process.env.RPC_URL_BASE_MAINNET = "https://base-mainnet.g.alchemy.com/v2/key";
    expect(hasRpcOverride("base:mainnet")).toBe(true);
  });

  /**
   * An empty string is how a variable gets "unset" in a compose file, and it
   * is not an endpoint. `rpcUrlOverride` already falls back on it; this has to
   * agree, or the two disagree about which endpoint is in use.
   */
  it("treats an empty value as absent, exactly as rpcUrlOverride does", () => {
    process.env.RPC_URL_BASE_MAINNET = "";
    expect(hasRpcOverride("base:mainnet")).toBe(false);
    expect(rpcUrlOverride("base:mainnet", "https://mainnet.base.org")).toBe("https://mainnet.base.org");
  });

  /**
   * The case a string comparison against the default gets wrong: an override
   * set to the same URL as the default is still an explicit decision, and
   * reporting it as "default" tells the operator their setting did nothing.
   */
  it("is true even when the override equals the descriptor default", () => {
    process.env.RPC_URL_BASE_MAINNET = "https://mainnet.base.org";
    expect(hasRpcOverride("base:mainnet")).toBe(true);
    expect(rpcUrlOverride("base:mainnet", "https://mainnet.base.org")).toBe("https://mainnet.base.org");
  });

  it("is per chain, not global", () => {
    process.env.RPC_URL_BASE_MAINNET = "https://base-mainnet.g.alchemy.com/v2/key";
    expect(hasRpcOverride("base:mainnet")).toBe(true);
    expect(hasRpcOverride("solana:mainnet")).toBe(false);
  });
});
