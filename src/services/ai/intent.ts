const PORTFOLIO_KEYWORDS = [
  "balance",
  "portfolio",
  "holdings",
  "pnl",
  "profit",
  "loss",
  "worth",
  "how much",
  "wallet",
  "assets",
  "trade history",
  "my trades",
  "make today",
  "lose today",
  "value",
];

/**
 * Fast keyword classifier to determine if a natural language input
 * requires retrieving the user's wallet and portfolio balance context.
 * Returns true if context is needed, false otherwise.
 */
export function needsPortfolioContext(input: string): boolean {
  const normalized = input.toLowerCase();
  return PORTFOLIO_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

/**
 * Deterministic command parser for suggested commands and standard queries.
 * Guarantees zero latency and fail-closed correctness even if LLM APIs fail or return unknown actions.
 */
export function fallbackParseCommand(input: string): Record<string, unknown> | null {
  const trimmed = input.trim();
  const lower = trimmed.toLowerCase();

  // 1. Wallets query / navigation
  if (
    lower === "show my wallets list" ||
    lower === "show wallets" ||
    lower === "wallets" ||
    lower === "my wallets" ||
    lower.includes("show my wallet") ||
    lower.includes("list my wallet") ||
    lower.includes("view my wallet")
  ) {
    return {
      action: "info",
      topic: "wallets",
      suggestedLink: "/wallets",
      replyText: "Redirecting you to your Wallets management page.",
    };
  }

  // 2. What are trading agents? / Explain agents
  if (
    lower === "what are trading agents?" ||
    lower === "what is a trading agent?" ||
    lower === "what are agents?" ||
    lower.includes("explain agents") ||
    lower.includes("what are trading agents")
  ) {
    return {
      action: "chat",
      replyText:
        "Trading agents in AstroidBot are autonomous AI-driven strategy engines that execute grid trading, DCA setups, and portfolio rebalancing according to your custom risk parameters.",
      suggestedLink: "/agents",
    };
  }

  // 3. Halt bot execution
  if (
    lower === "halt the bot execution" ||
    lower === "halt bot" ||
    lower === "stop bot" ||
    lower === "pause bot" ||
    lower.includes("halt the bot") ||
    lower.includes("stop trading bot")
  ) {
    return {
      action: "halt",
      replyText: "Halting automated bot execution across all active strategies.",
    };
  }

  // 4. Resume bot execution
  if (
    lower === "resume the bot execution" ||
    lower === "resume bot" ||
    lower === "start bot" ||
    lower === "unpause bot" ||
    lower.includes("resume the bot") ||
    lower.includes("start trading bot")
  ) {
    return {
      action: "resume",
      replyText: "Resuming automated bot execution across all active strategies.",
    };
  }

  // 5. Slippage setting (e.g., "Set slippageBps to 150" or "Set slippage to 100")
  const slippageMatch = lower.match(/(?:set\s+)?slippage(?:bps)?\s+(?:to\s+)?(\d+)/i);
  if (slippageMatch) {
    const value = parseInt(slippageMatch[1]!, 10);
    if (!isNaN(value)) {
      return {
        action: "settings",
        key: "slippageBps",
        value,
        replyText: `Updated your trading slippage configuration to ${value} bps (${(value / 100).toFixed(1)}%).`,
      };
    }
  }

  // 6. Direct Swap pattern (e.g. "Swap 10 STX for USDCx" or "Swap 5 SOL to USDC")
  const swapMatch = trimmed.match(
    /^swap\s+([\d.]+)\s+([a-zA-Z0-9.\-_]+)\s+(?:for|to|with)\s+([a-zA-Z0-9.\-_]+)/i
  );
  if (swapMatch) {
    const amountIn = parseFloat(swapMatch[1]!);
    const tokenIn = swapMatch[2]!.toUpperCase();
    const tokenOut = swapMatch[3]!.toUpperCase();
    if (!isNaN(amountIn) && tokenIn && tokenOut) {
      return {
        action: "trade",
        tokenIn,
        tokenOut,
        amountIn,
        direction: "BUY",
        replyText: `Parsed swap request: ${amountIn} ${tokenIn} → ${tokenOut}. Executing order...`,
      };
    }
  }

  // 7. Navigation queries (e.g. "take me to portfolio", "show limit orders", "open settings", "tokens")
  if (lower.includes("portfolio") || lower.includes("balance") || lower.includes("holdings")) {
    return {
      action: "info",
      topic: "portfolio",
      suggestedLink: "/portfolio",
      replyText: "Redirecting you to your Portfolio dashboard.",
    };
  }
  if (lower.includes("limit order") || lower.includes("orders")) {
    return {
      action: "info",
      topic: "orders",
      suggestedLink: "/limit-orders",
      replyText: "Redirecting you to the Limit Orders page.",
    };
  }
  if (lower.includes("trade history") || lower.includes("my trades")) {
    return {
      action: "info",
      topic: "trades",
      suggestedLink: "/trades",
      replyText: "Redirecting you to your Trade History.",
    };
  }
  if (lower.includes("token discovery") || lower.includes("tokens") || lower.includes("markets")) {
    return {
      action: "info",
      topic: "tokens",
      suggestedLink: "/tokens",
      replyText: "Redirecting you to Token Discovery.",
    };
  }
  if (lower.includes("setting")) {
    return {
      action: "info",
      topic: "settings",
      suggestedLink: "/settings",
      replyText: "Redirecting you to Settings.",
    };
  }

  return null;
}

