import { describe, it, expect, beforeEach } from "vitest";
import { ConfigManager } from "../../../src/config.js";
import { indexerSettings, settingsForChain } from "../../../src/services/indexer/settings.js";
import {
  BASE_MAINNET,
  CELO_MAINNET,
  ETHEREUM_MAINNET,
  ROBINHOOD_MAINNET,
  ARC_TESTNET,
} from "../../../src/services/chains/descriptors/index.js";
import type { ChainDescriptor } from "../../../src/types/chain.js";

/**
 * The indexer's safety margins are counted in blocks but protect spans of
 * time, and this deployment's chains run from ~100ms to ~12s a block. A single
 * global block count therefore delivers wildly different guarantees — which is
 * what these lock down.
 */

function loadConfig(extra: Record<string, string> = {}) {
  process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
  process.env.AES_KEY = "testkey";
  process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
  if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
  if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
  for (const key of ["INDEXER_CONFIRMATIONS", "INDEXER_CONFIRMATION_SECONDS"]) delete process.env[key];
  Object.assign(process.env, extra);
  ConfigManager.reset();
  ConfigManager.load();
}

/** Seconds of chain a chain's confirmation depth actually covers. */
function reorgWindowSeconds(descriptor: ChainDescriptor): number {
  const resolved = settingsForChain(descriptor, indexerSettings());
  return resolved.confirmations * (descriptor.indexer?.blockTimeSeconds ?? 0);
}

describe("per-chain indexer settings", () => {
  beforeEach(() => loadConfig());

  describe("confirmations", () => {
    it("gives every chain at least the configured reorg window in seconds", () => {
      const target = indexerSettings().confirmationSeconds;

      for (const chain of [ETHEREUM_MAINNET, BASE_MAINNET, CELO_MAINNET, ROBINHOOD_MAINNET]) {
        expect(reorgWindowSeconds(chain)).toBeGreaterThanOrEqual(target);
      }
    });

    it("scales the block count to the chain's rate", () => {
      const base = indexerSettings();

      // 60s target ÷ 0.101s blocks. The whole point: twelve blocks here was
      // 1.2 seconds of protection.
      expect(settingsForChain(ROBINHOOD_MAINNET, base).confirmations).toBe(595);
      expect(settingsForChain(CELO_MAINNET, base).confirmations).toBe(60);
      expect(settingsForChain(BASE_MAINNET, base).confirmations).toBe(30);
    });

    it("never lowers the configured floor", () => {
      // Ethereum's 12 blocks is already 144s, well past the 60s target, so the
      // derivation must leave it alone. A derived value that quietly weakened
      // an explicit setting would be worse than no derivation at all.
      const resolved = settingsForChain(ETHEREUM_MAINNET, indexerSettings());
      expect(resolved.confirmations).toBe(12);
      expect(reorgWindowSeconds(ETHEREUM_MAINNET)).toBe(144);
    });

    it("respects a raised global floor on every chain", () => {
      loadConfig({ INDEXER_CONFIRMATIONS: "1000" });
      const base = indexerSettings();

      for (const chain of [ETHEREUM_MAINNET, BASE_MAINNET, ROBINHOOD_MAINNET]) {
        expect(settingsForChain(chain, base).confirmations).toBeGreaterThanOrEqual(1000);
      }
    });

    it("follows the configured seconds target", () => {
      loadConfig({ INDEXER_CONFIRMATION_SECONDS: "300" });
      const base = indexerSettings();

      // 300s ÷ 0.101 = 2971 blocks.
      expect(settingsForChain(ROBINHOOD_MAINNET, base).confirmations).toBe(2971);
      expect(reorgWindowSeconds(ROBINHOOD_MAINNET)).toBeCloseTo(300, 0);
    });
  });

  describe("initial lookback", () => {
    it("reaches the same span of history on a fast chain as a slow one", () => {
      const base = indexerSettings();
      const hours = (d: ChainDescriptor) =>
        (settingsForChain(d, base).initialLookbackBlocks * d.indexer!.blockTimeSeconds!) / 3600;

      // 50,000 blocks was 1.4h on Robinhood and 13.9h on Celo. Both now clear
      // the configured target.
      for (const chain of [BASE_MAINNET, CELO_MAINNET, ROBINHOOD_MAINNET]) {
        expect(hours(chain)).toBeGreaterThanOrEqual(base.initialLookbackHours);
      }
    });

    it("leaves slow chains on the block floor", () => {
      // 50,000 blocks is already 6.9 days of Ethereum; deriving 6 hours from
      // its block time would be a large reduction.
      const resolved = settingsForChain(ETHEREUM_MAINNET, indexerSettings());
      expect(resolved.initialLookbackBlocks).toBe(50_000);
    });
  });

  describe("chains that state nothing", () => {
    it("keeps the globals exactly", () => {
      const base = indexerSettings();
      expect(ARC_TESTNET.indexer).toBeUndefined();
      expect(settingsForChain(ARC_TESTNET, base)).toEqual(base);
    });

    it("keeps the globals when a descriptor gives no block time", () => {
      const base = indexerSettings();
      const chain = { ...BASE_MAINNET, indexer: {} } as ChainDescriptor;

      expect(settingsForChain(chain, base).confirmations).toBe(base.confirmations);
      expect(settingsForChain(chain, base).initialLookbackBlocks).toBe(base.initialLookbackBlocks);
    });
  });

  describe("explicit overrides", () => {
    it("win over anything derived", () => {
      const base = indexerSettings();
      const chain = {
        ...ROBINHOOD_MAINNET,
        indexer: { blockTimeSeconds: 0.101, confirmations: 5, initialLookbackBlocks: 99 },
      } as ChainDescriptor;

      const resolved = settingsForChain(chain, base);
      expect(resolved.confirmations).toBe(5);
      expect(resolved.initialLookbackBlocks).toBe(99);
    });
  });

  it("changes nothing else about the settings", () => {
    const base = indexerSettings();
    const resolved = settingsForChain(ROBINHOOD_MAINNET, base);

    // Only the two block-denominated margins may differ; everything else is
    // carried through untouched.
    const strip = (s: typeof base) =>
      Object.fromEntries(
        Object.entries(s).filter(([k]) => k !== "confirmations" && k !== "initialLookbackBlocks")
      );

    expect(strip(resolved)).toEqual(strip(base));
  });
});
