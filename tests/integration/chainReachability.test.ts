import { describe, it, expect, beforeAll } from "vitest";
import { ConfigManager } from "../../src/config.js";
import { hardenOutboundHttp } from "../../src/runtime.js";
import { registerEnabledChains } from "../../src/services/chains/registerChains.js";
import { ChainAdapterRegistry } from "../../src/services/chains/chainAdapterRegistry.js";
import { DEXRegistry } from "../../src/services/dex/dexRegistry.js";
import type { ChainDescriptor } from "../../src/types/chain.js";

/**
 * Can every chain this deployment claims to trade on actually be traded on?
 *
 * This suite exists because of a specific failure that nothing else could see.
 * `solana:mainnet` pointed at `quote-api.jup.ag/v6`, a host Jupiter had
 * retired. The chain registered, listed its tokens, passed the adapter
 * conformance suite, and answered "no route" to every pair — which on a
 * discovery page is indistinguishable from a chain nobody trades on. Unit
 * tests can't catch it: the endpoint being alive is a fact about the world.
 *
 * So the assertions here are deliberately about *reachability*, not about
 * prices. A quote of the wrong size is a bug; no quote at all is an outage or
 * a dead endpoint, and those are what this is for.
 *
 * Run with the chains you actually deploy:
 *   ENABLED_CHAINS="stacks:mainnet,base:mainnet,solana:mainnet" npm run test:integration
 */

/** Trade size used to probe a route. Small enough to route on thin pairs. */
const PROBE_AMOUNT = 0.01;

let tradable: ChainDescriptor[] = [];

beforeAll(() => {
  hardenOutboundHttp();

  process.env.ASTROIDBOT_DATABASE_URL ??= "postgresql://localhost:5432/test";
  process.env.AES_KEY ??= "testkey";
  process.env.JWT_SECRET ??= "change-me-in-production-to-32-char-min-xyz";
  if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
  if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;

  ConfigManager.reset();
  ConfigManager.load();

  ChainAdapterRegistry.getInstance().reset();
  registerEnabledChains();

  tradable = ChainAdapterRegistry.getInstance().tradable();
});

describe("chain reachability", () => {
  it("has at least one tradable chain to check", () => {
    // Guards against the suite passing because ENABLED_CHAINS was empty or
    // every chain was listable-only — a green run over nothing.
    expect(tradable.length).toBeGreaterThan(0);
  });

  it("registers a DEX provider for every tradable chain", () => {
    // `tradable: true` is a claim the descriptor makes. This is the first
    // place it can be checked against reality.
    for (const descriptor of tradable) {
      const providers = DEXRegistry.getInstance().getProvidersForChain(descriptor.chainId);
      expect(providers.length, `${descriptor.chainId} has no DEX provider`).toBeGreaterThan(0);
    }
  });

  it("lists tokens on every tradable chain", async () => {
    for (const descriptor of tradable) {
      const tokens = await DEXRegistry.getInstance().getSwappableTokens(false, descriptor.chainId);
      expect(tokens.length, `${descriptor.chainId} lists no tokens`).toBeGreaterThan(0);

      // The stable has to be listable: it is what every price is denominated
      // in, and limitOrder.ts quotes against it by symbol.
      //
      // The *native* asset deliberately isn't checked. On EVM chains it is
      // absent from the list by design — pools hold only ERC-20s, so Base
      // lists WETH and the provider resolves "ETH" to it. Asserting its
      // presence would fail on exactly the chains where the handling is
      // correct. Whether the native asset can actually be traded is settled by
      // the quote below, which is the question that matters anyway.
      const symbols = tokens.map((t) => t.symbol);
      expect(symbols, `${descriptor.chainId} is missing its stable`).toContain(
        descriptor.stableSymbol
      );
    }
  });

  it("returns a live quote on every tradable chain", async () => {
    // The actual regression test. Reaching here with amountOut of 0 is what a
    // retired endpoint looks like from the inside.
    const failures: string[] = [];

    for (const descriptor of tradable) {
      const quote = await DEXRegistry.getInstance()
        .getBestQuote(
          descriptor.nativeSymbol,
          descriptor.stableSymbol,
          PROBE_AMOUNT,
          descriptor.chainId
        )
        .catch(() => null);

      if (!quote || quote.quote.amountOut <= 0) {
        failures.push(
          `${descriptor.chainId}: no route for ${descriptor.nativeSymbol}->${descriptor.stableSymbol}`
        );
      }
    }

    // Reported together rather than failing on the first: when several chains
    // are down at once that is a different diagnosis from one being down, and
    // stopping at the first hides it.
    expect(failures, failures.join("; ")).toEqual([]);
  });

  it("builds a swap payload on every tradable chain", async () => {
    // A quote proves the pricing endpoint answers. This proves the *swap*
    // endpoint does too — on Jupiter they are different calls, and on the EVM
    // it is the difference between the quoter and the router.
    const failures: string[] = [];

    for (const descriptor of tradable) {
      const adapter = ChainAdapterRegistry.getInstance().get(descriptor.chainId);
      const { address } = await adapter.generateWalletKeypair();

      const providers = DEXRegistry.getInstance().getProvidersForChain(descriptor.chainId);
      const payload = await providers[0]!
        .buildSwapPayload(
          descriptor.nativeSymbol,
          descriptor.stableSymbol,
          PROBE_AMOUNT,
          0,
          address
        )
        .catch(() => null);

      if (!payload) failures.push(`${descriptor.chainId}: could not build a swap payload`);
    }

    expect(failures, failures.join("; ")).toEqual([]);
  });
});
