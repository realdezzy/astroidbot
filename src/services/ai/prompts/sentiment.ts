export function buildSentimentPrompt(
  symbols: string[],
  priceData: Record<string, number[]>
): string {
  const dataStr = symbols
    .map((s) => {
      const prices = priceData[s] ?? [];
      const priceStr = prices.slice(-7).join(", ");
      const change = prices.length >= 2
        ? (((prices[prices.length - 1]! - prices[0]!) / prices[0]!) * 100).toFixed(2)
        : "N/A";
      return `${s}: recent prices [${priceStr}], 7d change: ${change}%`;
    })
    .join("\n");

  return `Analyze the following Stacks blockchain token price data and provide market sentiment.

Token data:
${dataStr}

Respond in JSON format:
{
  "overallSentiment": "BULLISH" | "BEARISH" | "NEUTRAL",
  "confidence": number (0-1),
  "reasoning": "string"
}`;
}
