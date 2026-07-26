import {
  createPublicClient,
  http,
  encodeFunctionData,
  parseUnits,
  type Hex,
  type PublicClient,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { base, baseSepolia } from "viem/chains";
import { entryPoint07Address } from "viem/account-abstraction";
import { createSmartAccountClient } from "permissionless";
import { toSafeSmartAccount } from "permissionless/accounts";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { ConfigManager } from "../../../config.js";
import { DatabaseService } from "../../db.js";
import { RedisService } from "../../redis.js";
import { KMSService } from "../../kms.js";
import { logger } from "../../../utils/logger.js";
import { toDecimalString } from "../../../utils/decimal.js";
import { ERC20_ABI } from "./abis.js";
import type { ChainAdapter } from "../../../types/chainAdapter.js";

const SAFE_VERSION = "1.4.1" as const;
const ENTRY_POINT = { address: entryPoint07Address, version: "0.7" as const };

// The Stacks path holds its wallet lock only until broadcast, but
// smartAccountClient.sendTransaction resolves on the UserOperation *receipt*,
// so the lock is held for the whole inclusion window. 30s (the Stacks TTL)
// routinely expires mid-flight under congestion, which would let a second job
// sign for the same wallet concurrently. Release is compare-and-delete, so an
// overrun can no longer clobber another holder's lock either.
const USER_OP_LOCK_TTL_MS = 300_000;

// Stop re-polling a UserOperation that never landed. Bundlers drop
// non-includable ops, and without a cap such a trade sits PENDING forever,
// re-checked by every cycle and blocking the wallet's pending-trade guard.
const CONFIRMATION_TIMEOUT_MS = 30 * 60 * 1000;

// ERC-4337 smart-account custody on Base via Pimlico (bundler + paymaster).
// The private key AstroidBot encrypts/stores is the Safe owner's EOA key, not
// the traded-from address — Wallet.address is the Safe's counterfactual
// address, computed deterministically from the owner key (see
// generateWalletKeypair/deriveAddressFromPrivateKey below).
export class BaseAdapter implements ChainAdapter {
  readonly chainFamily = "evm";
  readonly nativeSymbol = "ETH";
  readonly nativeDecimals = 18;
  readonly stableSymbol = "USDC";

  chainId(): string {
    return `base:${ConfigManager.getInstance().config.BASE_NETWORK}`;
  }

  private chain() {
    const network = ConfigManager.getInstance().config.BASE_NETWORK;
    return network === "mainnet" ? base : baseSepolia;
  }

  private rpcUrl(): string {
    const configured = ConfigManager.getInstance().config.BASE_RPC_URL;
    return configured || this.chain().rpcUrls.default.http[0]!;
  }

  private pimlicoUrl(): string {
    const apiKey = ConfigManager.getInstance().config.PIMLICO_API_KEY;
    if (!apiKey) {
      throw new Error("PIMLICO_API_KEY is not configured — Base support requires a Pimlico API key");
    }
    const slug = this.chain().id === base.id ? "base" : "base-sepolia";
    return `https://api.pimlico.io/v2/${slug}/rpc?apikey=${apiKey}`;
  }

  private publicClient(): PublicClient {
    return createPublicClient({ chain: this.chain(), transport: http(this.rpcUrl()) }) as PublicClient;
  }

  private pimlicoClient() {
    return createPimlicoClient({
      transport: http(this.pimlicoUrl()),
      entryPoint: ENTRY_POINT,
    });
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

  private async smartAccountClientFor(ownerPrivateKeyHex: Hex) {
    const smartAccount = await this.smartAccountFor(ownerPrivateKeyHex);
    const pimlico = this.pimlicoClient();
    return createSmartAccountClient({
      account: smartAccount,
      chain: this.chain(),
      bundlerTransport: http(this.pimlicoUrl()),
      paymaster: pimlico,
      userOperation: {
        estimateFeesPerGas: async () => (await pimlico.getUserOperationGasPrice()).fast,
      },
    });
  }

  async generateWalletKeypair(): Promise<{ privateKeyHex: string; address: string }> {
    const privateKeyHex = generatePrivateKey();
    const smartAccount = await this.smartAccountFor(privateKeyHex);
    return { privateKeyHex, address: smartAccount.address };
  }

  async deriveAddressFromPrivateKey(privateKeyHex: string): Promise<string> {
    const smartAccount = await this.smartAccountFor(privateKeyHex as Hex);
    return smartAccount.address;
  }

  // EVM-shaped execution: one or more to/data/value calls sent as a single
  // sponsored UserOperation (Safe smart accounts execute a batch atomically).
  // This is what Uniswap V3 swaps (approve + swap) and any other Base
  // contract interaction go through — there's no Stacks-style "contract name
  // + Clarity args" concept here, so executeContractCall is intentionally
  // not implemented by this adapter.
  async executeEvmCall(params: {
    calls: { to: string; data: string; value?: bigint }[];
    walletId: number;
    senderAddress: string;
  }): Promise<{ txId: string } | { error: string }> {
    const db = DatabaseService.getInstance();
    const redis = RedisService.getInstance();
    const lockKey = `wallet:${params.walletId}`;
    const lockToken = await redis.acquireLock(lockKey, USER_OP_LOCK_TTL_MS);

    if (!lockToken) {
      return { error: `Wallet ${params.walletId} is busy executing another transaction` };
    }

    try {
      const wallet = await db.findWalletById(params.walletId);
      if (!wallet) {
        return { error: `Wallet ${params.walletId} not found` };
      }

      const config = ConfigManager.getInstance().config;
      if (config.DRY_RUN) {
        logger.info("DRY RUN: would send Base UserOperation", {
          calls: params.calls.length,
          sender: params.senderAddress,
        });
        return { txId: "dry-run-tx-id" };
      }

      const ownerPrivateKeyHex = await KMSService.getInstance().decryptPrivateKey(wallet.encryptedKey);
      const client = await this.smartAccountClientFor(ownerPrivateKeyHex as Hex);

      const txHash = await client.sendTransaction({
        calls: params.calls.map((c) => ({
          to: c.to as Hex,
          data: c.data as Hex,
          value: c.value ?? 0n,
        })),
      });

      logger.info("Base UserOperation submitted", { txHash, sender: params.senderAddress, calls: params.calls.length });
      return { txId: txHash };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Base transaction failed", { error: message, calls: params.calls.length });
      return { error: message };
    } finally {
      await redis.releaseLock(lockKey, lockToken);
    }
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
    if (params.token.toUpperCase() === "ETH") {
      const value = parseUnits(toDecimalString(params.amount), 18);
      return this.executeEvmCall({
        calls: [{ to: params.toAddress, data: "0x", value }],
        walletId: params.walletId,
        senderAddress: params.senderAddress,
      });
    }

    const decimals = params.decimals ?? 18;
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
    const db = DatabaseService.getInstance();

    if (txId === "dry-run-tx-id") {
      await db.updateTradeStatus(tradeId, "CONFIRMED", txId);
      return "confirmed";
    }

    try {
      const receipt = await this.publicClient().getTransactionReceipt({ hash: txId as Hex });
      if (receipt.status === "success") {
        await db.updateTradeStatus(tradeId, "CONFIRMED", txId);
        return "confirmed";
      }
      await db.updateTradeStatus(tradeId, "FAILED", txId, "Transaction reverted");
      return "failed";
    } catch {
      // Receipt not found — either still pending inclusion, or the bundler
      // dropped the UserOperation. Age it out rather than polling forever.
      const trade = await db.prisma.trade.findUnique({
        where: { id: tradeId },
        select: { createdAt: true },
      });
      const age = trade ? Date.now() - trade.createdAt.getTime() : 0;
      if (age > CONFIRMATION_TIMEOUT_MS) {
        logger.warn("Base transaction never landed — marking failed", { txId, tradeId, ageMs: age });
        await db.updateTradeStatus(
          tradeId,
          "FAILED",
          txId,
          `No receipt after ${Math.round(CONFIRMATION_TIMEOUT_MS / 60000)} minutes — UserOperation likely dropped`
        );
        return "failed";
      }
      return "pending";
    }
  }
}
