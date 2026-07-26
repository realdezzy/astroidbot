import type { ChainAdapter } from "../../types/chainAdapter.js";
import type { RebalanceAction } from "../../types.js";
import { ConfigManager } from "../../config.js";
import { generateWalletKeypair, deriveAddressFromPrivateKey } from "../wallet.js";
import { TransactionService } from "../transaction.js";

// Thin delegate over the existing Stacks-specific wallet.ts/transaction.ts —
// deliberately not a rewrite. TransactionService's fee estimation, post-condition
// building, nonce handling, mempool verification, and gasless relay logic are
// left untouched; this class only exists so ChainAdapterRegistry has a "stacks"
// entry with the same shape a future EVM/Solana adapter will have.
export class StacksAdapter implements ChainAdapter {
  readonly chainFamily = "stacks";
  readonly nativeSymbol = "STX";
  readonly nativeDecimals = 6;
  readonly stableSymbol = "USDCx";

  chainId(): string {
    const network = ConfigManager.getInstance().config.STACKS_NETWORK;
    return `stacks:${network === "mainnet" ? "mainnet" : "testnet"}`;
  }

  async generateWalletKeypair(): Promise<{ privateKeyHex: string; address: string }> {
    return generateWalletKeypair();
  }

  async deriveAddressFromPrivateKey(privateKeyHex: string): Promise<string> {
    return deriveAddressFromPrivateKey(privateKeyHex);
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
      params.decimals ?? 6
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
