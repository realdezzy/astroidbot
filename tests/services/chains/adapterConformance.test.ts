import { describe, it, expect, beforeAll } from "vitest";
import { ConfigManager } from "../../../src/config.js";
import { BUILT_IN_DESCRIPTORS } from "../../../src/services/chains/descriptors/index.js";
import type { ChainAdapter } from "../../../src/types/chainAdapter.js";
import type { ChainDescriptor, ChainFamily } from "../../../src/types/chain.js";

/**
 * The contract every ChainAdapter must satisfy, applied to every chain this
 * build can describe.
 *
 * Written because the per-adapter suites could not answer the question that
 * actually matters when someone adds chain #10: *did they implement the whole
 * contract?* Each adapter had its own tests, so a new chain was tested only as
 * thoroughly as whoever added it remembered to be — and the failure mode of a
 * half-implemented adapter is not a crash at startup. It is a chain that
 * registers, lists, shows balances, and then throws on the first trade.
 *
 * `describe.each` over the descriptor catalogue means adding a descriptor
 * automatically adds a test subject. Nobody has to remember.
 */

/** Which execute method a family is required to have, and which it must not. */
const EXECUTION_METHOD: Record<ChainFamily, keyof ChainAdapter> = {
  stacks: "executeContractCall",
  evm: "executeEvmCall",
  svm: "executeSvmCall",
};

const ALL_EXECUTION_METHODS = Object.values(EXECUTION_METHOD);

describe("ChainAdapter conformance", { timeout: 60_000 }, () => {
  let adapterFor: (d: ChainDescriptor) => ChainAdapter;

  beforeAll(async () => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    // Chains configured for ERC-4337 refuse to build without it, and this
    // suite is about the contract rather than about that guard.
    process.env.PIMLICO_API_KEY = "pim_test_key";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    ConfigManager.reset();
    ConfigManager.load();

    const { StacksAdapter } = await import("../../../src/services/chains/stacksAdapter.js");
    const { EvmChainAdapter } = await import(
      "../../../src/services/chains/evm/evmChainAdapter.js"
    );
    const { SolanaAdapter } = await import("../../../src/services/chains/svm/solanaAdapter.js");

    adapterFor = (d) => {
      switch (d.family) {
        case "stacks":
          return new StacksAdapter(d);
        case "evm":
          return new EvmChainAdapter(d);
        case "svm":
          return new SolanaAdapter(d);
        default:
          throw new Error(`No adapter for family ${d.family}`);
      }
    };
  });

  it("has at least one descriptor per family, or this suite proves nothing", () => {
    const families = new Set(BUILT_IN_DESCRIPTORS.map((d) => d.family));
    expect([...families].sort()).toEqual(["evm", "stacks", "svm"]);
  });

  // The catalogue drives the cases, so adding a descriptor adds a subject.
  describe.each(BUILT_IN_DESCRIPTORS.map((d) => [d.chainId, d] as const))(
    "%s",
    (chainId, descriptor) => {
      let adapter: ChainAdapter;

      beforeAll(() => {
        adapter = adapterFor(descriptor);
      });

      it("carries the descriptor it was built from", () => {
        // The whole design rests on adapters reading constants from the
        // descriptor rather than declaring their own. An adapter that has
        // drifted from its descriptor is one that hardcoded something.
        expect(adapter.descriptor.chainId).toBe(chainId);
        expect(adapter.chainId()).toBe(chainId);
        expect(adapter.chainFamily).toBe(descriptor.family);
        expect(adapter.nativeSymbol).toBe(descriptor.nativeSymbol);
        expect(adapter.nativeDecimals).toBe(descriptor.nativeDecimals);
        expect(adapter.stableSymbol).toBe(descriptor.stableSymbol);
      });

      it("implements exactly the execution method its family dispatches to", () => {
        // executeSwapPayload branches on payload kind and calls one of these.
        // A missing one is not a type error at the call site — the methods are
        // optional — so it surfaces as a runtime failure on the first trade.
        const required = EXECUTION_METHOD[descriptor.family];
        expect(typeof adapter[required], `${chainId} must implement ${required}`).toBe(
          "function"
        );

        // And must not implement another family's shape: that would mean a
        // payload of the wrong kind gets executed rather than rejected.
        for (const method of ALL_EXECUTION_METHODS) {
          if (method === required) continue;
          expect(adapter[method], `${chainId} must not implement ${method}`).toBeUndefined();
        }
      });

      it("implements the methods every family shares", () => {
        for (const method of [
          "generateWalletKeypair",
          "deriveAddressFromPrivateKey",
          "transfer",
          "confirmTransaction",
        ] as const) {
          expect(typeof adapter[method], `${chainId}.${method}`).toBe("function");
        }
      });

      // ERC-4337 chains are excluded from the two generation cases below, and
      // only from those. Their `address` is a Safe's *counterfactual* address,
      // which cannot be computed without asking the chain — so running these
      // here would make a unit suite depend on a live RPC and a real Pimlico
      // key. That path is covered against mocks in evmChainAdapter.test.ts.
      const isSmartAccount = descriptor.evm?.custody === "erc4337";
      const generates = isSmartAccount ? it.skip : it;

      generates("generates a keypair whose address it can re-derive", async () => {
        // The round trip is the property that matters: an address stored at
        // creation that the adapter would derive differently at signing time
        // means funds sent to an account nothing can spend from.
        const { privateKey, address } = await adapter.generateWalletKeypair();

        // The encoding is the adapter's business and the families genuinely
        // differ: EVM returns 0x-prefixed hex, Stacks bare hex, Solana base58.
        // That is safe only because a key is never handed to an adapter other
        // than the one that produced it — which is why the field was renamed
        // from `privateKeyHex` when this suite caught the mismatch. What all
        // three must guarantee is that it is a single printable token, since
        // KMSService encrypts it as text.
        expect(privateKey).toMatch(/^\S+$/);
        expect(address.length).toBeGreaterThan(0);

        const derived = await adapter.deriveAddressFromPrivateKey(privateKey);
        expect(derived).toBe(address);
      });

      generates("generates a distinct keypair each time", async () => {
        const [a, b] = await Promise.all([
          adapter.generateWalletKeypair(),
          adapter.generateWalletKeypair(),
        ]);
        expect(a.privateKey).not.toBe(b.privateKey);
        expect(a.address).not.toBe(b.address);
      });

      it("configures a bundler if it claims smart-account custody", () => {
        // EvmChainAdapter's constructor throws on this, so reaching here at
        // all proves it — but stating it keeps the requirement visible to
        // whoever writes the next descriptor.
        if (!isSmartAccount) return;
        expect(descriptor.evm?.bundler).toBeDefined();
      });

      it("produces an explorer link containing what it was given", () => {
        // Cheap, and it catches the copy-paste error this file format invites:
        // a descriptor whose explorer URLs still point at the chain it was
        // copied from is only visible by reading the string.
        const tx = descriptor.explorerTxUrl("0xdeadbeef");
        const addr = descriptor.explorerAddressUrl("0xc0ffee");
        expect(tx).toContain("0xdeadbeef");
        expect(addr).toContain("0xc0ffee");
        expect(tx).toMatch(/^https:\/\//);
        expect(addr).toMatch(/^https:\/\//);
      });

      it("is only tradable when it has something to route through", () => {
        // `tradable` gates whether DEXRegistry will ever quote the chain.
        // Claiming it without a router configured is how a chain reaches the
        // trade UI and then fails with "no route" on every pair.
        if (!descriptor.tradable) return;

        const hasRouter =
          (descriptor.family === "evm" && Boolean(descriptor.evm?.dex)) ||
          (descriptor.family === "svm" && Boolean(descriptor.svm?.jupiterApiUrl)) ||
          descriptor.family === "stacks"; // ALEX/Bitflow/Velar register per-DEX

        expect(hasRouter, `${chainId} is tradable but has no router configured`).toBe(true);
      });

      it("prices against something other than itself, if it trades at all", () => {
        // limitOrder.ts quotes nativeSymbol against stableSymbol. Where the
        // two are equal every price reads 1 and no price trigger can ever
        // fire — the shape of the bug that made stableSymbol
        // descriptor-driven in the first place.
        //
        // Scoped to tradable chains because equality is legitimate elsewhere:
        // Arc's gas token *is* USDC, so its native and stable symbols are
        // genuinely the same asset. It carries no DEX, so nothing ever asks
        // it for a price. A tradable chain in that position would be a bug.
        if (!descriptor.tradable) return;
        expect(descriptor.stableSymbol).not.toBe(descriptor.nativeSymbol);
      });
    }
  );
});
