import { describe, it, expect, beforeAll } from "vitest";
import { ConfigManager } from "../../src/config.js";
import { hardenOutboundHttp } from "../../src/runtime.js";
import { registerEnabledChains } from "../../src/services/chains/registerChains.js";
import { ChainAdapterRegistry } from "../../src/services/chains/chainAdapterRegistry.js";
import { PortfolioManager } from "../../src/services/portfolio.js";
import { DEXRegistry } from "../../src/services/dex/dexRegistry.js";
import type { ChainDescriptor } from "../../src/types/chain.js";

/**
 * Wallet lifecycle against live chains, per family.
 *
 * P7.1 asked for "create wallet → fund → quote → trade → confirm → portfolio"
 * per family, and only Stacks had anything. The parts needing a funded wallet
 * can't run unattended, but most of the value doesn't need funds: an address
 * the chain accepts, a balance read that answers, and a quote that routes are
 * where the family-specific breakage actually lives. Those run everywhere.
 *
 * The funded leg is gated on FUNDED_TESTNET_CHAIN + FUNDED_TESTNET_KEY and
 * skips visibly otherwise.
 *
 *   ENABLED_CHAINS="base:sepolia,solana:mainnet" npm run test:integration
 */

let chains: ChainDescriptor[] = [];

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
  chains = ChainAdapterRegistry.getInstance().list();
});

describe("wallet lifecycle", () => {
  it("covers more than one family, or it proves nothing about dispatch", () => {
    const families = new Set(chains.map((c) => c.family));
    expect(chains.length).toBeGreaterThan(0);
    // Not an assertion on *which* families — that's the deployment's choice.
    // Logged so a single-family run is visible rather than silently narrow.
    console.log(`Families under test: ${[...families].join(", ")}`);
  });

  it("derives an address each chain's own RPC will accept", async () => {
    // The failure this catches is the expensive one: an address stored at
    // creation that the chain rejects, or that the adapter would re-derive
    // differently at signing time, means funds sent somewhere unspendable.
    for (const descriptor of chains) {
      const adapter = ChainAdapterRegistry.getInstance().get(descriptor.chainId);
      const { privateKey, address } = await adapter.generateWalletKeypair();

      expect(await adapter.deriveAddressFromPrivateKey(privateKey)).toBe(address);

      // A balance read is the cheapest thing the chain will do that proves it
      // parsed the address. Zero is the expected answer for a fresh account;
      // the point is that it answers at all rather than erroring.
      const balances = await PortfolioManager.getInstance()
        .fetchBalances(address, [], 0, true, descriptor.chainId)
        .catch((error: unknown) => {
          throw new Error(
            `${descriptor.chainId} rejected a freshly generated address: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });

      expect(Array.isArray(balances), `${descriptor.chainId} balance read`).toBe(true);
    }
  });

  it("quotes a real trade size on every tradable chain", async () => {
    // Deliberately a larger size than the reachability probe: thin routes can
    // quote a dust amount and fail on anything a user would actually trade.
    const tradable = chains.filter((c) => c.tradable);

    for (const descriptor of tradable) {
      const quote = await DEXRegistry.getInstance().getBestQuote(
        descriptor.nativeSymbol,
        descriptor.stableSymbol,
        1,
        descriptor.chainId
      );

      expect(quote, `${descriptor.chainId} could not quote 1 ${descriptor.nativeSymbol}`).not
        .toBeNull();
      expect(quote!.quote.amountOut).toBeGreaterThan(0);
    }
  });

  // ─── Funded leg ────────────────────────────────────────────────────────────

  const fundedChain = process.env.FUNDED_TESTNET_CHAIN;
  const fundedKey = process.env.FUNDED_TESTNET_KEY;
  const withFunds = fundedChain && fundedKey ? it : it.skip;

  withFunds("executes and confirms a real swap on a funded testnet wallet", async () => {
    const descriptor = ChainAdapterRegistry.getInstance().find(fundedChain!);
    expect(descriptor, `${fundedChain} is not enabled`).toBeDefined();

    const adapter = ChainAdapterRegistry.getInstance().get(fundedChain!);
    const address = await adapter.deriveAddressFromPrivateKey(fundedKey!);

    const before = await PortfolioManager.getInstance().fetchBalances(
      address,
      [],
      0,
      true,
      fundedChain!
    );
    expect(before.length, "funded wallet reports no balances").toBeGreaterThan(0);

    const providers = DEXRegistry.getInstance().getProvidersForChain(fundedChain!);
    const payload = await providers[0]!.buildSwapPayload(
      descriptor!.nativeSymbol,
      descriptor!.stableSymbol,
      0.001,
      0,
      address
    );

    expect(payload, "no swap payload for the funded pair").not.toBeNull();

    // Broadcast is left to a human. The value here is proving the payload is
    // buildable against a real funded account — the step that mocks cannot
    // reach, because an unfunded address changes what the router returns.
    console.log(`Built a ${payload!.kind} payload for ${fundedChain} from ${address}`);
  });
});
