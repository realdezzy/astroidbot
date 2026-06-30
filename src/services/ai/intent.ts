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
