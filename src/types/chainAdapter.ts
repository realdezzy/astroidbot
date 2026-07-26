import type { RebalanceAction } from "../types.js";

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
  readonly chainFamily: string;

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

  // Concrete network identifier persisted to Wallet.chain — "stacks:mainnet",
  // "base:sepolia". chainFamily says which adapter handles the wallet; this
  // says which network within that family it lives on, and is resolved from
  // config at call time so it reflects the deployment's current network.
  chainId(): string;

  generateWalletKeypair(): Promise<{ privateKeyHex: string; address: string }>;
  deriveAddressFromPrivateKey(privateKeyHex: string): Promise<string>;

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
