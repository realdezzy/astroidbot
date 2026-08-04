import type { ClarityValue, PostCondition } from "@stacks/transactions";

/**
 * Clarity call arguments, in either form that genuinely reaches
 * TransactionService.execute.
 *
 * DEX providers hand over `ClarityValue`s they built themselves; perpService
 * passes the string forms `parseClarityArgs` understands. Both are real call
 * paths, so the union is the honest type — this was `any[]`, which typechecked
 * everything and described nothing.
 */
export type ClarityArgs = ClarityValue[] | string[];
export interface SwappableToken {
  contractId: string;
  symbol: string;
  name: string;
  decimals: number;
  supportedBy?: string[];
  // Stamped by DEXRegistry when merging provider token lists. Absent means
  // "stacks" — tokens from providers written before multi-chain support.
  chainFamily?: string;
  // Concrete network the token lives on ("base:mainnet"). Two chains in the
  // same family can both list "USDC" at different addresses, so this is what
  // actually disambiguates a token; chainFamily alone does not.
  chainId?: string;
}

export interface PortfolioTarget {
  token: string;
  targetWeight: number;
}

export interface RebalanceAction {
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  direction: "BUY" | "SELL";
  reason: string;
  slippageBps?: number;
}

export interface GridSpreadConfig {
  tokenPair: string;
  midPrice: number;
  levels: number;
  spreadBps: number;
}

export enum BotStatus {
  IDLE = "IDLE",
  RUNNING = "RUNNING",
  HALTED = "HALTED",
  ERROR = "ERROR",
}

export interface BotState {
  status: BotStatus;
  lastCycle: Date | null;
  dailyPnl: number;
  haltedReason: string | null;
}

export interface TokenBalance {
  token: string;
  symbol: string;
  balance: number;
  usdValue: number;
}

export interface SwapRoute {
  tokenIn: string;
  tokenOut: string;
  pairContract: string;
  expectedOutput: number;
  priceImpact: number;
}

// Stacks-shaped fields are optional (not just present-for-Stacks) so an EVM
// DEXProvider can return an evm-kind payload without populating irrelevant
// Clarity-call fields. Dispatch on `kind` happens in one place —
// executeSwapPayload (src/services/chains/executeSwap.ts) — which every
// trade-execution call site goes through.
export interface TransactionPayload {
  kind?: "stacks" | "evm" | "svm";
  // Stacks
  contractAddress?: string;
  contractName?: string;
  functionName?: string;
  functionArgs?: ClarityValue[];
  postConditions?: PostCondition[];
  // EVM — always a list of calls (single-call is a one-element array) so a
  // provider can express multi-step operations (e.g. ERC-20 approve + swap)
  // as one batched UserOperation.
  calls?: { to: string; data: string; value?: string }[];
  // Solana — a base64 transaction the provider (e.g. Jupiter) already built
  // and serialized. Solana aggregators return a complete unsigned transaction
  // rather than a call list, so forcing it into the EVM shape would mean
  // taking it apart only to reassemble it; the adapter signs and sends it.
  swapTransaction?: string;
  // Address lookup tables the transaction references, when the caller needs
  // them for local reconstruction.
  addressLookupTables?: string[];
}

// Narrows an svm payload before the Solana branch dereferences it, mirroring
// assertStacksPayload. A payload of the wrong kind reaching here is a bug in
// the provider that built it, not a user error.
export function assertSvmPayload(payload: TransactionPayload): asserts payload is TransactionPayload & {
  swapTransaction: string;
} {
  if (!payload.swapTransaction) {
    throw new Error("Expected an SVM-shaped TransactionPayload (swapTransaction)");
  }
}

// Narrows a payload to its Stacks shape at the point of Stacks execution. All
// Stacks DEXProvider implementations populate these fields, so this throws only
// if a payload of the wrong kind reaches the Stacks branch — executeSwapPayload
// catches it and surfaces it as a trade error rather than an exception.
export function assertStacksPayload(payload: TransactionPayload): asserts payload is TransactionPayload & {
  contractAddress: string;
  contractName: string;
  functionName: string;
  functionArgs: ClarityValue[];
  postConditions: PostCondition[];
} {
  if (
    !payload.contractAddress ||
    !payload.contractName ||
    !payload.functionName ||
    !payload.functionArgs ||
    !payload.postConditions
  ) {
    throw new Error(
      "Expected a Stacks-shaped TransactionPayload (contractAddress/contractName/functionName/functionArgs/postConditions)"
    );
  }
}

export interface AISentimentResult {
  overallSentiment: "BULLISH" | "BEARISH" | "NEUTRAL";
  confidence: number;
  reasoning: string;
  timestamp: Date;
}

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}
