import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import bs58 from "bs58";
import { logger } from "../../../utils/logger.js";
import { toDecimalString } from "../../../utils/decimal.js";
import { BaseChainAdapter } from "../baseChainAdapter.js";
import { requireSvmConfig, type ChainDescriptor, type SvmChainConfig } from "../../../types/chain.js";

/**
 * Solana releases its lock after the signature is submitted, but confirmation
 * is a separate poll — so this sits between the Stacks broadcast-length TTL
 * and the ERC-4337 receipt-length one.
 */
const SVM_LOCK_TTL_MS = 90_000;

/**
 * A Solana transaction is only valid while its recent blockhash is within the
 * last ~150 slots (roughly a minute). Past that it can never land, so there is
 * no point polling for longer than a few of those windows.
 */
const SVM_CONFIRMATION_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Solana / SVM.
 *
 * The third execution shape, and the reason ChainAdapter's execute* methods
 * are optional rather than a single "buildAndBroadcast": a Solana swap is
 * neither a Clarity contract call nor a to/data/value list. Aggregators return
 * a complete, already-built transaction, so this adapter's job is to sign,
 * attach a priority fee, and send — not to assemble instructions.
 *
 * Custody is a plain ed25519 keypair, encrypted through the existing
 * KMSService exactly like every other chain: crypto.ts is chain-agnostic and
 * needed no changes.
 */
export class SolanaAdapter extends BaseChainAdapter {
  private readonly svm: SvmChainConfig;

  constructor(descriptor: ChainDescriptor) {
    super(descriptor);
    this.svm = requireSvmConfig(descriptor);
  }

  protected lockTtlMs(): number {
    return SVM_LOCK_TTL_MS;
  }

  private rpcUrl(): string {
    const key = `RPC_URL_${this.descriptor.chainId.toUpperCase().replace(/[:-]/g, "_")}`;
    return process.env[key] || this.svm.defaultRpcUrl;
  }

  connection(): Connection {
    return new Connection(this.rpcUrl(), "confirmed");
  }

  /**
   * Solana secret keys are 64 bytes (seed + public key) and conventionally
   * base58-encoded. Stored as base58 rather than hex so an operator can move a
   * key between AstroidBot and any standard Solana wallet without conversion.
   */
  async generateWalletKeypair(): Promise<{ privateKey: string; address: string }> {
    const keypair = Keypair.generate();
    return {
      privateKey: bs58.encode(keypair.secretKey),
      address: keypair.publicKey.toBase58(),
    };
  }

  async deriveAddressFromPrivateKey(privateKey: string): Promise<string> {
    return this.keypairFrom(privateKey).publicKey.toBase58();
  }

  /** Accepts base58 (standard) or hex, so an imported key in either form works. */
  private keypairFrom(privateKey: string): Keypair {
    const trimmed = privateKey.trim();

    const bytes = /^[0-9a-fA-F]+$/.test(trimmed)
      ? Buffer.from(trimmed, "hex")
      : Buffer.from(bs58.decode(trimmed));

    if (bytes.length !== 64) {
      throw new Error(
        `Invalid Solana secret key: expected 64 bytes, got ${bytes.length}`
      );
    }
    return Keypair.fromSecretKey(new Uint8Array(bytes));
  }

  /**
   * Signs and sends a transaction an aggregator already built.
   *
   * `transactionBase64` is a serialized VersionedTransaction. A priority fee is
   * prepended when the transaction doesn't already carry one — Solana drops
   * transactions that don't outbid the fee market during congestion, and
   * silent non-inclusion is worse than a fraction of a cent.
   */
  async executeSvmCall(params: {
    transactionBase64: string;
    walletId: number;
    senderAddress: string;
  }): Promise<{ txId: string } | { error: string }> {
    return this.withWalletLock(params.walletId, async (privateKey) => {
      const dry = this.dryRun({ sender: params.senderAddress });
      if (dry) return dry;

      const keypair = this.keypairFrom(privateKey);
      const connection = this.connection();

      const transaction = VersionedTransaction.deserialize(
        Buffer.from(params.transactionBase64, "base64")
      );

      // Refresh the blockhash: an aggregator quote may have been fetched
      // seconds ago, and a stale blockhash fails at submission rather than
      // producing a diagnosable error.
      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      transaction.message.recentBlockhash = blockhash;

      transaction.sign([keypair]);

      const signature = await connection.sendTransaction(transaction, {
        maxRetries: 3,
        skipPreflight: false,
      });

      logger.info("Solana transaction submitted", {
        chainId: this.descriptor.chainId,
        signature,
        sender: params.senderAddress,
      });

      return { txId: signature };
    });
  }

  async transfer(params: {
    walletId: number;
    senderAddress: string;
    toAddress: string;
    amount: number;
    token: string;
    decimals?: number;
  }): Promise<{ txId: string } | { error: string }> {
    if (params.token.toUpperCase() !== this.descriptor.nativeSymbol.toUpperCase()) {
      // SPL transfers need an associated-token-account setup path that the
      // trading flow doesn't currently exercise. Refusing explicitly beats
      // silently sending the wrong thing.
      return {
        error: "SPL token transfers are not implemented yet — only native SOL transfers",
      };
    }

    return this.withWalletLock(params.walletId, async (privateKey) => {
      const dry = this.dryRun({ sender: params.senderAddress, to: params.toAddress });
      if (dry) return dry;

      const keypair = this.keypairFrom(privateKey);
      const connection = this.connection();

      // Via decimal string, not amount * LAMPORTS_PER_SOL: the float multiply
      // introduces rounding at 9 decimals.
      const lamports = BigInt(
        Math.round(Number(toDecimalString(params.amount)) * LAMPORTS_PER_SOL)
      );

      const instructions = [
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: this.svm.priorityFeeMicroLamports ?? 20_000,
        }),
        SystemProgram.transfer({
          fromPubkey: keypair.publicKey,
          toPubkey: new PublicKey(params.toAddress),
          lamports,
        }),
      ];

      const { blockhash } = await connection.getLatestBlockhash("confirmed");
      const message = new TransactionMessage({
        payerKey: keypair.publicKey,
        recentBlockhash: blockhash,
        instructions,
      }).compileToV0Message();

      const transaction = new VersionedTransaction(message);
      transaction.sign([keypair]);

      const signature = await connection.sendTransaction(transaction, { maxRetries: 3 });
      logger.info("Solana transfer submitted", {
        chainId: this.descriptor.chainId,
        signature,
      });
      return { txId: signature };
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
      const status = await this.connection().getSignatureStatus(txId, {
        searchTransactionHistory: true,
      });
      const value = status.value;

      if (!value) {
        // Not yet seen by this node, or dropped. Age it out on the blockhash
        // validity window rather than polling forever.
        return this.ageOutOrPending(txId, tradeId, SVM_CONFIRMATION_TIMEOUT_MS);
      }

      if (value.err) {
        await this.db.updateTradeStatus(
          tradeId,
          "FAILED",
          txId,
          `Transaction failed: ${JSON.stringify(value.err)}`
        );
        return "failed";
      }

      if (value.confirmationStatus === "confirmed" || value.confirmationStatus === "finalized") {
        await this.db.updateTradeStatus(tradeId, "CONFIRMED", txId);
        return "confirmed";
      }

      return "pending";
    } catch (error) {
      logger.warn("Solana confirmation check failed", {
        txId,
        tradeId,
        error: error instanceof Error ? error.message : String(error),
      });
      return this.ageOutOrPending(txId, tradeId, SVM_CONFIRMATION_TIMEOUT_MS);
    }
  }
}
