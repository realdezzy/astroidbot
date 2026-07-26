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
  kind?: "stacks" | "evm";
  // Stacks
  contractAddress?: string;
  contractName?: string;
  functionName?: string;
  functionArgs?: any[];
  postConditions?: any[];
  // EVM — always a list of calls (single-call is a one-element array) so a
  // provider can express multi-step operations (e.g. ERC-20 approve + swap)
  // as one batched UserOperation.
  calls?: { to: string; data: string; value?: string }[];
}

// Narrows a payload to its Stacks shape at the point of Stacks execution. All
// Stacks DEXProvider implementations populate these fields, so this throws only
// if a payload of the wrong kind reaches the Stacks branch — executeSwapPayload
// catches it and surfaces it as a trade error rather than an exception.
export function assertStacksPayload(payload: TransactionPayload): asserts payload is TransactionPayload & {
  contractAddress: string;
  contractName: string;
  functionName: string;
  functionArgs: any[];
  postConditions: any[];
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
