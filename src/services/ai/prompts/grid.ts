export function buildGridPrompt(
  tokenPair: string,
  volatility: number,
  midPrice: number
): string {
  return `Configure a grid-based market making strategy for the ${tokenPair} pair on Stacks DEX.

Current mid-price: ${midPrice}
Recent volatility: ${(volatility * 100).toFixed(2)}%

Determine optimal grid parameters considering:
- Higher volatility = wider spreads
- Lower volatility = tighter spreads, more levels
- Grid levels should be symmetric above and below mid-price

Respond in JSON format:
{
  "levels": number (3-10),
  "spreadBps": number (basis points per level)
}`;
}
