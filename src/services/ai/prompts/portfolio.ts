import type { TokenBalance, AISentimentResult } from "../../../types.js";

export function buildPortfolioPrompt(
  balances: TokenBalance[],
  sentiment: AISentimentResult
): string {
  const totalValue = balances.reduce((sum, b) => sum + b.usdValue, 0);

  const balanceStr = balances
    .map((b) => {
      const pct = totalValue > 0 ? ((b.usdValue / totalValue) * 100).toFixed(1) : "0";
      return `${b.symbol}: $${b.usdValue.toFixed(2)} (${pct}% of portfolio)`;
    })
    .join("\n");

  return `You are a portfolio manager for a Stacks blockchain trading bot.

Current portfolio (total value: $${totalValue.toFixed(2)}):
${balanceStr}

Market sentiment: ${sentiment.overallSentiment} (confidence: ${sentiment.confidence})
Reasoning: ${sentiment.reasoning}

Propose target portfolio weight allocations for each token. Weights must sum to 1.0.
Consider: diversification, risk management, current market sentiment, and token fundamentals.

Respond in JSON format:
{
  "targets": [
    { "token": "SYMBOL", "targetWeight": number }
  ]
}`;
}
