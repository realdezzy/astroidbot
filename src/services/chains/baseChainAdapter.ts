import { ConfigManager } from "../../config.js";
import { DatabaseService } from "../db.js";
import { RedisService } from "../redis.js";
import { KMSService } from "../kms.js";
import { logger } from "../../utils/logger.js";
import type { ChainAdapter } from "../../types/chainAdapter.js";
import type { ChainDescriptor, ChainFamily } from "../../types/chain.js";

/**
 * Give up re-polling a transaction that never landed. Without a cap such a
 * trade sits PENDING forever, is re-checked by every cycle, and blocks the
 * wallet's pending-trade guard. 30 minutes is far beyond any chain's normal
 * inclusion window; a transaction still missing after that is not coming.
 */
export const DEFAULT_CONFIRMATION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Behaviour every chain family shares, regardless of how it signs.
 *
 * Locking, just-in-time key decryption, the DRY_RUN short-circuit, the error
 * envelope and the "aged out, mark it failed" rule are identical whether the
 * chain speaks Clarity, EVM or SVM — they are properties of *custody*, not of
 * any chain. Before this class they existed once, inside BaseAdapter, and the
 * only way to add a chain was to copy them; four copies of a lock protocol is
 * four chances to get a lock protocol wrong.
 *
 * Subclasses implement only the parts that genuinely differ: how to make a
 * keypair, how to broadcast, and how to read a receipt.
 */
export abstract class BaseChainAdapter implements ChainAdapter {
  constructor(readonly descriptor: ChainDescriptor) { }

  get chainFamily(): ChainFamily {
    return this.descriptor.family;
  }

  get nativeSymbol(): string {
    return this.descriptor.nativeSymbol;
  }

  get nativeDecimals(): number {
    return this.descriptor.nativeDecimals;
  }

  get stableSymbol(): string {
    return this.descriptor.stableSymbol;
  }

  chainId(): string {
    return this.descriptor.chainId;
  }

  /**
   * How long this chain needs to hold a wallet lock.
   *
   * Not a constant, because the right value depends on what "done" means for
   * the chain: Stacks releases after *broadcast* (seconds), while an ERC-4337
   * UserOperation resolves on the *receipt* and can take minutes under
   * congestion. A 30s TTL on the latter expires mid-flight and lets a second
   * job sign for the same wallet concurrently.
   */
  protected abstract lockTtlMs(): number;

  protected get config() {
    return ConfigManager.getInstance().config;
  }

  protected get db(): DatabaseService {
    return DatabaseService.getInstance();
  }

  /**
   * Runs `fn` holding an exclusive lock on the wallet, with its decrypted
   * private key. The key is decrypted per call and never cached.
   *
   * Release is compare-and-delete against the token acquire returned, so a
   * holder whose lock expired mid-operation cannot delete the lock a different
   * holder has since taken.
   */
  protected async withWalletLock<T>(
    walletId: number,
    fn: (privateKey: string, wallet: { id: number; userId: number; address: string }) => Promise<T>
  ): Promise<T | { error: string }> {
    const redis = RedisService.getInstance();
    const lockKey = `wallet:${walletId}`;
    const lockToken = await redis.acquireLock(lockKey, this.lockTtlMs());

    if (!lockToken) {
      return { error: `Wallet ${walletId} is busy executing another transaction` };
    }

    try {
      const wallet = await this.db.findWalletById(walletId);
      if (!wallet) {
        return { error: `Wallet ${walletId} not found` };
      }

      const privateKey = await KMSService.getInstance().decryptPrivateKey(wallet.encryptedKey);
      return await fn(privateKey, wallet);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Chain transaction failed", {
        chainId: this.descriptor.chainId,
        walletId,
        error: message,
      });
      return { error: message };
    } finally {
      await redis.releaseLock(lockKey, lockToken);
    }
  }

  /**
   * Shared "has this transaction aged out?" decision for chains that poll for a
   * receipt. Returns "pending" while the transaction may still land and
   * "failed" once it has clearly been dropped.
   */
  protected async ageOutOrPending(
    txId: string,
    tradeId: number,
    timeoutMs = DEFAULT_CONFIRMATION_TIMEOUT_MS
  ): Promise<"failed" | "pending"> {
    const trade = await this.db.prisma.trade.findUnique({
      where: { id: tradeId },
      select: { createdAt: true },
    });
    const age = trade ? Date.now() - trade.createdAt.getTime() : 0;

    if (age > timeoutMs) {
      logger.warn("Transaction never landed — marking failed", {
        chainId: this.descriptor.chainId,
        txId,
        tradeId,
        ageMs: age,
      });
      await this.db.updateTradeStatus(
        tradeId,
        "FAILED",
        txId,
        `No receipt after ${Math.round(timeoutMs / 60000)} minutes — transaction likely dropped`
      );
      return "failed";
    }
    return "pending";
  }

  /** Shared DRY_RUN handling so no adapter forgets to honour the flag. */
  protected dryRun(detail: Record<string, unknown>): { txId: string } | null {
    if (!this.config.DRY_RUN) return null;
    logger.info("DRY RUN: would submit transaction", {
      chainId: this.descriptor.chainId,
      ...detail,
    });
    return { txId: "dry-run-tx-id" };
  }

  protected async markDryRunConfirmed(tradeId: number, txId: string): Promise<void> {
    await this.db.updateTradeStatus(tradeId, "CONFIRMED", txId);
  }

  abstract generateWalletKeypair(): Promise<{ privateKey: string; address: string }>;
  abstract deriveAddressFromPrivateKey(privateKey: string): Promise<string>;
  abstract transfer(params: {
    walletId: number;
    senderAddress: string;
    toAddress: string;
    amount: number;
    token: string;
    decimals?: number;
  }): Promise<{ txId: string } | { error: string }>;
  abstract confirmTransaction(
    txId: string,
    tradeId: number,
    poll?: boolean
  ): Promise<"confirmed" | "failed" | "pending">;
}
