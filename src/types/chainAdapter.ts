import type { RebalanceAction } from "../types.js";
import type { ChainDescriptor, ChainFamily } from "./chain.js";

/**
 * Chain-dispatch contract. Mirrors TransactionService's existing Stacks-specific
 * surface (execute/transfer/confirmTransaction) rather than a generic single
 * "buildAndBroadcast" — new chains implement this shape directly instead of
 * being force-fit into an abstraction none of them actually match.
 *
 * The two execution methods are both optional because "execute a trade" has no
 * single shape across chain families: Stacks is a contract call with Clarity
 * args + post-conditions (executeContractCall), EVM smart-account chains send
 * a to/data/value UserOperation (executeEvmCall), and future families (Solana
 * instructions, Hyperliquid signed orders) will need their own method rather
 * than being forced into either shape. Each adapter implements whichever
 * applies to it; callers branch on chainFamily to know which to call.
 */
export interface ChainAdapter {
  // Everything chain-specific that is data rather than behaviour: network id,
  // native/stable symbols, explorer URLs, per-family config. Adapters read
  // their constants from here instead of declaring their own, so adding a
  // chain is a descriptor file rather than a class.
  readonly descriptor: ChainDescriptor;

  // Execution shape — which of the optional execute* methods below applies.
  // Several chains share a family; it is NOT a unique key. Use
  // descriptor.chainId to identify a network.
  readonly chainFamily: ChainFamily;

  // Ticker of the chain's gas/native asset ("STX", "ETH"). Wallet.balance
  // stores this asset's balance, so wallet-listing code needs it to know which
  // entry of a TokenBalance[] is the native one without hardcoding "STX".
  readonly nativeSymbol: string;

  // Decimals of the native asset, and the sane fallback when a token's decimals
  // can't be resolved on this chain (6 for Stacks, 18 for EVM).
  readonly nativeDecimals: number;

  // Symbol of the USD stablecoin used to denominate prices on this chain
  // ("USDCx" on Stacks, "USDC" on Base). Price-trigger logic quotes against
  // this, so it must be a symbol the chain's DEX providers can actually route.
  readonly stableSymbol: string;

  // Concrete network identifier, equal to descriptor.chainId. Retained as a
  // method for the call sites that already use it.
  chainId(): string;

  /**
   * A new account for this chain.
   *
   * **The key's encoding is the adapter's own and differs by family** — EVM
   * returns 0x-prefixed hex, Stacks bare hex, Solana base58. That is safe only
   * because a key is never handed to an adapter other than the one that
   * produced it; do not parse one generically. (The field was called
   * `privateKeyHex` until the conformance suite pointed out that this was
   * false for Solana, and a caller who believed it would have decoded garbage.)
   *
   * `address` is what the chain will accept as a counterparty — for ERC-4337
   * chains that is the Safe's counterfactual address, not the owner EOA the
   * key belongs to.
   */
  generateWalletKeypair(): Promise<{ privateKey: string; address: string }>;
  deriveAddressFromPrivateKey(privateKey: string): Promise<string>;

  executeContractCall?(params: {
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
  }): Promise<{ txId: string } | { error: string }>;

  // `calls` is always an array (single-call is just a one-element array) so
  // multi-step EVM operations (e.g. ERC-20 approve + swap) can be submitted
  // as one batched UserOperation rather than needing sequential submissions.
  executeEvmCall?(params: {
    calls: { to: string; data: string; value?: bigint }[];
    walletId: number;
    senderAddress: string;
  }): Promise<{ txId: string } | { error: string }>;

  // Solana-shaped execution: aggregators return a complete serialized
  // transaction rather than a call list, so there is nothing to assemble —
  // the adapter refreshes the blockhash, signs and sends. A third method
  // rather than a reshaped executeEvmCall, for the same reason executeEvmCall
  // exists alongside executeContractCall: the shapes genuinely differ.
  executeSvmCall?(params: {
    transactionBase64: string;
    walletId: number;
    senderAddress: string;
  }): Promise<{ txId: string } | { error: string }>;

  transfer(params: {
    walletId: number;
    senderAddress: string;
    toAddress: string;
    amount: number;
    token: string;
    decimals?: number;
  }): Promise<{ txId: string } | { error: string }>;

  confirmTransaction(
    txId: string,
    tradeId: number,
    poll?: boolean
  ): Promise<"confirmed" | "failed" | "pending">;
}
