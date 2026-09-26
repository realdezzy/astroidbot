import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getMint,
  getAssociatedTokenAddressSync,
  createTransferCheckedInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import bs58 from "bs58";
import { logger } from "../../../utils/logger.js";
import { toDecimalString } from "../../../utils/decimal.js";
import { BaseChainAdapter } from "../baseChainAdapter.js";
import { requireSvmConfig, type ChainDescriptor, type SvmChainConfig } from "../../../types/chain.js";
import { rpcUrlOverride } from "../evm/evmClient.js";

/**
 * A decimal amount as integer base units, without ever multiplying a float.
 *
 * `Math.round(amount * 10 ** decimals)` is the obvious way and is wrong at the
 * precision Solana uses: 1.005 at 9 decimals is 1004999999.9999999 as a
 * double, so rounding lands a unit short, and above 2^53 the multiply
 * quantizes outright. Scaling the decimal string moves no bits.
 */
function toBaseUnits(amount: number, decimals: number): bigint {
  const text = toDecimalString(amount);
  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? text.slice(1) : text).split(".");
  // Truncated, not rounded: a caller asking to send more precision than the
  // token has is asking for something the token cannot represent.
  const scaled = (fraction + "0".repeat(decimals)).slice(0, decimals);
  const value = BigInt(whole + scaled);
  return negative ? -value : value;
}

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
    return rpcUrlOverride(this.descriptor.chainId, this.svm.defaultRpcUrl);
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
   * `transactionBase64` is a serialized VersionedTransaction.
   *
   * The priority fee comes from Jupiter, which sets one when it builds the
   * transaction; the descriptor's `priorityFeeMicroLamports` applies to the
   * `transfer` path below and not to this one. This comment previously claimed
   * that a fee was prepended here when the transaction didn't already carry
   * one, and no such code existed — worth stating plainly, because a fee that
   * is documented but absent shows up as silent non-inclusion during
   * congestion, which is the hardest failure on this chain to attribute.
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
    const isNative = params.token.toUpperCase() === this.descriptor.nativeSymbol.toUpperCase();

    // Parsed before the lock and before the DRY_RUN short-circuit, because
    // these two checks need no network and a dry run that reports success on an
    // unparseable address is worse than useless — it is the run you did
    // *instead* of finding out. Note `token` here is a mint address, not a
    // symbol: this adapter has no symbol resolution, so "USDC" is a caller bug.
    let recipient: PublicKey;
    try {
      recipient = new PublicKey(params.toAddress);
    } catch {
      return { error: `"${params.toAddress}" is not a valid Solana address` };
    }

    let mint: PublicKey | undefined;
    if (!isNative) {
      try {
        mint = new PublicKey(params.token);
      } catch {
        return {
          error: `"${params.token}" is not a valid SPL mint address — ` +
            `pass a mint, not a token symbol`,
        };
      }
    }

    return this.withWalletLock(params.walletId, async (privateKey) => {
      const dry = this.dryRun({ sender: params.senderAddress, to: params.toAddress });
      if (dry) return dry;

      const keypair = this.keypairFrom(privateKey);
      const connection = this.connection();

      const instructions = [
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: this.svm.priorityFeeMicroLamports ?? 20_000,
        }),
      ];

      if (isNative) {
        instructions.push(
          SystemProgram.transfer({
            fromPubkey: keypair.publicKey,
            toPubkey: recipient,
            lamports: toBaseUnits(params.amount, this.descriptor.nativeDecimals),
          })
        );
      } else {
        // An SPL transfer, which Solana wallets previously could not do at all:
        // this returned "not implemented", so a user could acquire a position
        // through Jupiter and then have no way to move it out.
        //
        // Non-null: `mint` is set above for every non-native token.
        const splMint = mint!;

        // Which token program owns the mint decides both the transfer
        // instruction's program and how the associated token addresses derive,
        // so it is read rather than assumed — Token-2022 mints built against
        // the classic program derive an address that belongs to nobody.
        const mintAccount = await connection.getAccountInfo(splMint);
        if (!mintAccount) {
          return { error: `Mint ${params.token} was not found on ${this.descriptor.chainId}` };
        }

        const tokenProgram = mintAccount.owner;
        if (
          !tokenProgram.equals(TOKEN_PROGRAM_ID) &&
          !tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
        ) {
          return { error: `${params.token} is not an SPL token mint` };
        }

        // Read on-chain when the caller doesn't state them. Never defaulted:
        // decimals scale the amount being sent, so assuming 9 for a 6-decimal
        // token sends a thousand times what was asked.
        let decimals = params.decimals;
        if (decimals === undefined) {
          try {
            decimals = (await getMint(connection, splMint, undefined, tokenProgram)).decimals;
          } catch (error) {
            return {
              error: `Could not read decimals for ${params.token}: ` +
                `${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }

        const source = getAssociatedTokenAddressSync(splMint, keypair.publicKey, true, tokenProgram);
        const destination = getAssociatedTokenAddressSync(splMint, recipient, true, tokenProgram);

        // Idempotent: a recipient who has never held this mint has no account
        // to credit, and the plain create instruction fails if two concurrent
        // sends both try to make it.
        instructions.push(
          createAssociatedTokenAccountIdempotentInstruction(
            keypair.publicKey, destination, recipient, splMint, tokenProgram
          )
        );

        // Checked, not the plain transfer: it makes the cluster verify the
        // decimals we scaled by, so a wrong value fails the transaction instead
        // of quietly moving the wrong amount.
        instructions.push(
          createTransferCheckedInstruction(
            source,
            splMint,
            destination,
            keypair.publicKey,
            toBaseUnits(params.amount, decimals),
            decimals,
            [],
            tokenProgram
          )
        );
      }

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

  /**
   * `_poll` is accepted for interface compatibility and deliberately ignored,
   * as on EVM: this reads the signature status once and ages the trade out
   * rather than blocking on a transaction the cluster may never include. A
   * Solana blockhash is only valid for ~150 slots, so "still pending" resolves
   * itself within `SVM_CONFIRMATION_TIMEOUT_MS` either way.
   */
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
