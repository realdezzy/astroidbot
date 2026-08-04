import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  http,
  isAddress,
  parseUnits,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { entryPoint07Address } from "viem/account-abstraction";
import { createSmartAccountClient } from "permissionless";
import { toSafeSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { ConfigManager } from "../../../config.js";
import { logger } from "../../../utils/logger.js";
import { toDecimalString } from "../../../utils/decimal.js";
import { BaseChainAdapter } from "../baseChainAdapter.js";
import { sponsorGasFor, sponsorshipAvailability } from "../gasSponsorship.js";
import { ERC20_ABI } from "./abis.js";
import { requireEvmConfig, type ChainDescriptor, type EvmChainConfig } from "../../../types/chain.js";

const SAFE_VERSION = "1.4.1" as const;
const ENTRY_POINT = { address: entryPoint07Address, version: "0.7" as const };

/**
 * ERC-4337 resolves on the UserOperation *receipt*, not on broadcast, so the
 * lock is held for the whole inclusion window. The Stacks TTL (30s) routinely
 * expires mid-flight under congestion, which would let a second job sign for
 * the same wallet concurrently.
 */
const USER_OP_LOCK_TTL_MS = 300_000;

/** An EOA submits and returns immediately, so it needs only a broadcast-length lock. */
const EOA_LOCK_TTL_MS = 60_000;

/**
 * Every EVM chain, parameterised by its descriptor.
 *
 * This holds what used to be BaseAdapter in its entirety. Base, Celo and any
 * chain declared through CUSTOM_EVM_CHAINS are now config, not code — which is
 * the whole test of the descriptor split: if adding an EVM chain requires
 * touching this file, the abstraction has failed.
 *
 * Two custody modes, because "EVM support" must not mean "support for the
 * chains one bundler happens to serve":
 *
 *  - erc4337: a Safe smart account submitted via Pimlico's bundler+paymaster.
 *    Calls batch atomically in a single UserOperation, which an ERC-20 swap
 *    needs (it is really "approve + swap"), and gas can be sponsored. The
 *    stored key is the Safe *owner's* EOA key; Wallet.address is the Safe's
 *    counterfactual address, deterministic from that key and requiring no
 *    on-chain transaction until first use.
 *
 *  - eoa: a plain account signing directly. Works on any EVM chain. No
 *    batching, so multi-call payloads are submitted sequentially and the
 *    caller sees the last hash; the user pays their own gas.
 */
export class EvmChainAdapter extends BaseChainAdapter {
  private readonly evm: EvmChainConfig;

  constructor(descriptor: ChainDescriptor) {
    super(descriptor);
    this.evm = requireEvmConfig(descriptor);
    this.assertValidAddresses();
  }

  /**
   * Fail loudly at registration on a malformed address.
   *
   * Base's mainnet QuoterV2 constant was 39 hex characters for months. viem
   * threw InvalidAddressError inside the per-fee-tier catch, all three tiers
   * "missed", and the user saw "No swap route found" with nothing in the logs —
   * a dead chain that looked exactly like an empty market. A bad constant now
   * stops the process at startup instead.
   */
  private assertValidAddresses(): void {
    const candidates: Array<[string, string | undefined]> = [
      ["wrappedNative", this.evm.wrappedNative],
      ["dex.quoter", this.evm.dex?.quoter],
      ["dex.swapRouter", this.evm.dex?.swapRouter],
      ...Object.entries(this.evm.tokens ?? {}).map(
        ([symbol, t]) => [`tokens.${symbol}`, t.address] as [string, string]
      ),
    ];

    const bad = candidates
      .filter(([, value]) => value !== undefined && !isAddress(value))
      .map(([label, value]) => `${label}=${value}`);

    if (bad.length) {
      throw new Error(
        `Chain ${this.descriptor.chainId} has malformed EVM address(es): ${bad.join(", ")}`
      );
    }

    if (this.evm.custody === "erc4337" && !this.evm.bundler) {
      throw new Error(
        `Chain ${this.descriptor.chainId} uses erc4337 custody but has no bundler configured`
      );
    }
  }

  protected lockTtlMs(): number {
    return this.evm.custody === "erc4337" ? USER_OP_LOCK_TTL_MS : EOA_LOCK_TTL_MS;
  }

  /** viem Chain object built from the descriptor — no viem/chains import needed. */
  private chain(): Chain {
    return defineChain({
      id: this.evm.id,
      name: this.descriptor.displayName,
      nativeCurrency: {
        name: this.descriptor.nativeSymbol,
        symbol: this.descriptor.nativeSymbol,
        decimals: this.descriptor.nativeDecimals,
      },
      rpcUrls: { default: { http: [this.rpcUrl()] } },
      testnet: this.descriptor.isTestnet,
    });
  }

  private rpcUrl(): string {
    // Per-chain override, e.g. RPC_URL_BASE_MAINNET, so a deployment can point
    // at its own node without a code change.
    const key = `RPC_URL_${this.descriptor.chainId.toUpperCase().replace(/[:-]/g, "_")}`;
    const override = process.env[key];
    return override || this.evm.defaultRpcUrl;
  }

  publicClient(): PublicClient {
    return createPublicClient({
      chain: this.chain(),
      transport: http(this.rpcUrl()),
    }) as PublicClient;
  }

  private pimlicoUrl(): string {
    const apiKey = ConfigManager.getInstance().config.PIMLICO_API_KEY;
    if (!apiKey) {
      throw new Error(
        `PIMLICO_API_KEY is not configured — ${this.descriptor.chainId} uses erc4337 custody`
      );
    }
    return `https://api.pimlico.io/v2/${this.evm.bundler!.slug}/rpc?apikey=${apiKey}`;
  }

  private pimlicoClient() {
    return createPimlicoClient({ transport: http(this.pimlicoUrl()), entryPoint: ENTRY_POINT });
  }

  private async smartAccountFor(ownerPrivateKeyHex: Hex) {
    const owner = privateKeyToAccount(ownerPrivateKeyHex);
    return toSafeSmartAccount({
      client: this.publicClient(),
      owners: [owner],
      version: SAFE_VERSION,
      entryPoint: ENTRY_POINT,
    });
  }

  /**
   * A smart-account client, with or without the paymaster.
   *
   * Omitting `paymaster` is the whole of "sponsorship off": the UserOperation
   * is otherwise identical and the Safe pays for it from its own native
   * balance. The bundler is still required either way — it is what submits the
   * operation, sponsored or not.
   */
  private async smartAccountClientFor(ownerPrivateKeyHex: Hex, sponsorGas: boolean) {
    const smartAccount = await this.smartAccountFor(ownerPrivateKeyHex);
    const pimlico = this.pimlicoClient();
    return createSmartAccountClient({
      account: smartAccount,
      chain: this.chain(),
      bundlerTransport: http(this.pimlicoUrl()),
      ...(sponsorGas ? { paymaster: pimlico } : {}),
      userOperation: {
        estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast,
      },
    });
  }

  async generateWalletKeypair(): Promise<{ privateKey: string; address: string }> {
    const privateKey = generatePrivateKey();
    return { privateKey, address: await this.deriveAddressFromPrivateKey(privateKey) };
  }

  async deriveAddressFromPrivateKey(privateKey: string): Promise<string> {
    const key = privateKey as Hex;
    if (this.evm.custody === "eoa") {
      return privateKeyToAccount(key).address;
    }
    return (await this.smartAccountFor(key)).address;
  }

  /**
   * EVM-shaped execution: one or more to/data/value calls.
   *
   * Under erc4337 they go out as a single atomic UserOperation. Under eoa they
   * are submitted in order and the final hash is returned — callers get a
   * usable txId either way, but an eoa multi-call is NOT atomic and a later
   * call can fail after an earlier one succeeded. That is a real difference in
   * guarantees, not an implementation detail, so it is logged.
   */
  async executeEvmCall(params: {
    calls: { to: string; data: string; value?: bigint }[];
    walletId: number;
    senderAddress: string;
  }): Promise<{ txId: string } | { error: string }> {
    return this.withWalletLock(params.walletId, async (privateKey, wallet) => {
      // Checked inside the lock, not before it: a dry run should still exercise
      // the same contention path as a real send, so DRY_RUN testing catches
      // lock bugs rather than bypassing them.
      const dry = this.dryRun({ calls: params.calls.length, sender: params.senderAddress });
      if (dry) return dry;

      if (this.evm.custody === "eoa") {
        return this.sendAsEoa(privateKey as Hex, params.calls, params.senderAddress);
      }

      // Resolved here rather than passed in by callers. There are five
      // trade-execution entrypoints and a per-call parameter would be a
      // per-call opportunity to forget one — the same reasoning that put
      // RiskManager behind a single dispatch point.
      const sponsorGas =
        sponsorshipAvailability(this.descriptor).available &&
        (await sponsorGasFor(wallet.userId, this.descriptor.chainId));

      const client = await this.smartAccountClientFor(privateKey as Hex, sponsorGas);
      const txHash = await client.sendTransaction({
        calls: params.calls.map((c) => ({
          to: c.to as Hex,
          data: c.data as Hex,
          value: c.value ?? 0n,
        })),
      });

      logger.info("UserOperation submitted", {
        chainId: this.descriptor.chainId,
        txHash,
        sender: params.senderAddress,
        calls: params.calls.length,
        // Logged because it changes who pays and therefore why a send can
        // fail: unsponsored, an empty Safe reverts for want of native asset.
        sponsored: sponsorGas,
      });
      return { txId: txHash };
    });
  }

  private async sendAsEoa(
    privateKey: Hex,
    calls: { to: string; data: string; value?: bigint }[],
    senderAddress: string
  ): Promise<{ txId: string } | { error: string }> {
    const account = privateKeyToAccount(privateKey);
    const wallet = createWalletClient({
      account,
      chain: this.chain(),
      transport: http(this.rpcUrl()),
    });
    const publicClient = this.publicClient();

    if (calls.length > 1) {
      logger.warn("EOA custody submits calls sequentially, not atomically", {
        chainId: this.descriptor.chainId,
        calls: calls.length,
      });
    }

    let lastHash: Hex | undefined;
    for (const [i, call] of calls.entries()) {
      const hash = await wallet.sendTransaction({
        to: call.to as Hex,
        data: call.data as Hex,
        value: call.value ?? 0n,
      });
      // Wait for each call before sending the next: a swap that front-runs its
      // own approval reverts, and sequential nonces must land in order.
      if (i < calls.length - 1) {
        await publicClient.waitForTransactionReceipt({ hash });
      }
      lastHash = hash;
    }

    logger.info("EOA transaction(s) submitted", {
      chainId: this.descriptor.chainId,
      txHash: lastHash,
      sender: senderAddress,
      calls: calls.length,
    });
    return { txId: lastHash! };
  }

  async transfer(params: {
    walletId: number;
    senderAddress: string;
    toAddress: string;
    amount: number;
    token: string;
    decimals?: number;
  }): Promise<{ txId: string } | { error: string }> {
    // parseUnits rather than BigInt(amount * 10 ** decimals): at 18 decimals
    // the intermediate double exceeds 2^53 and silently quantizes the amount.
    if (params.token.toUpperCase() === this.descriptor.nativeSymbol.toUpperCase()) {
      const value = parseUnits(toDecimalString(params.amount), this.descriptor.nativeDecimals);
      return this.executeEvmCall({
        calls: [{ to: params.toAddress, data: "0x", value }],
        walletId: params.walletId,
        senderAddress: params.senderAddress,
      });
    }

    const decimals = params.decimals ?? this.descriptor.nativeDecimals;
    const rawAmount = parseUnits(toDecimalString(params.amount), decimals);
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "transfer",
      args: [params.toAddress as Hex, rawAmount],
    });

    return this.executeEvmCall({
      calls: [{ to: params.token, data }],
      walletId: params.walletId,
      senderAddress: params.senderAddress,
    });
  }

  async confirmTransaction(
    txId: string,
    tradeId: number,
    _poll = false
  ): Promise<"confirmed" | "failed" | "pending"> {
    if (txId === "dry-run-tx-id") {
      await this.markDryRunConfirmed(tradeId, txId);
      return "confirmed";
    }

    try {
      const receipt = await this.publicClient().getTransactionReceipt({ hash: txId as Hex });
      if (receipt.status === "success") {
        await this.db.updateTradeStatus(tradeId, "CONFIRMED", txId);
        return "confirmed";
      }
      await this.db.updateTradeStatus(tradeId, "FAILED", txId, "Transaction reverted");
      return "failed";
    } catch {
      // No receipt — either still awaiting inclusion, or dropped. Age it out
      // rather than polling forever.
      return this.ageOutOrPending(txId, tradeId);
    }
  }
}
