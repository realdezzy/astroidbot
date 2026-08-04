import { BaseChainAdapter } from "./baseChainAdapter.js";
import { STACKS_MAINNET, STACKS_TESTNET } from "./descriptors/stacks.js";
import { ConfigManager } from "../../config.js";
import { generateWalletKeypair, deriveAddressFromPrivateKey } from "../wallet.js";
import { TransactionService } from "../transaction.js";
import type { ChainDescriptor } from "../../types/chain.js";
import type { RebalanceAction } from "../../types.js";

/**
 * Stacks.
 *
 * A thin delegate over the existing wallet.ts / transaction.ts, deliberately
 * not a rewrite: TransactionService's fee estimation, post-condition building,
 * nonce handling, mempool verification and gasless relay logic are untouched
 * and still the only code path Stacks trades take.
 *
 * It therefore does NOT use BaseChainAdapter's withWalletLock — TransactionService
 * holds its own wallet lock internally, and wrapping it in a second lock would
 * deadlock. lockTtlMs() exists to satisfy the contract and documents the TTL
 * TransactionService actually uses.
 */
export class StacksAdapter extends BaseChainAdapter {
  constructor(descriptor?: ChainDescriptor) {
    super(descriptor ?? StacksAdapter.descriptorFromConfig());
  }

  private static descriptorFromConfig(): ChainDescriptor {
    return ConfigManager.getInstance().config.STACKS_NETWORK === "mainnet"
      ? STACKS_MAINNET
      : STACKS_TESTNET;
  }

  // TransactionService releases after broadcast, not after confirmation.
  protected lockTtlMs(): number {
    return 30_000;
  }

  async generateWalletKeypair(): Promise<{ privateKey: string; address: string }> {
    return generateWalletKeypair();
  }

  async deriveAddressFromPrivateKey(privateKey: string): Promise<string> {
    return deriveAddressFromPrivateKey(privateKey);
  }

  async executeContractCall(params: {
    action: RebalanceAction;
    contractAddress: string;
    contractName: string;
    functionName: string;
    functionArgs: any[];
    walletId: number;
    senderAddress: string;
    maxOutbound: number;
    useGasless?: boolean;
    postConditionsOverride?: any[];
  }): Promise<{ txId: string } | { error: string }> {
    return TransactionService.getInstance().execute(
      params.action,
      params.contractAddress,
      params.contractName,
      params.functionName,
      params.functionArgs,
      params.walletId,
      params.senderAddress,
      params.maxOutbound,
      params.useGasless ?? false,
      params.postConditionsOverride
    );
  }

  async transfer(params: {
    walletId: number;
    senderAddress: string;
    toAddress: string;
    amount: number;
    token: string;
    decimals?: number;
  }): Promise<{ txId: string } | { error: string }> {
    return TransactionService.getInstance().transfer(
      params.walletId,
      params.senderAddress,
      params.toAddress,
      params.amount,
      params.token,
      params.decimals ?? this.descriptor.nativeDecimals
    );
  }

  async confirmTransaction(
    txId: string,
    tradeId: number,
    poll = false
  ): Promise<"confirmed" | "failed" | "pending"> {
    return TransactionService.getInstance().confirmTransaction(txId, tradeId, poll);
  }
}
