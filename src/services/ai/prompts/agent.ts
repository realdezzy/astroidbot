export function buildAgentPrompt(
  agent: { name: string; context: string },
  wallets: Array<{ id: number; address: string; balance: number; chain?: string; chainFamily?: string }>,
  state: Record<string, unknown>,
  config: Record<string, unknown>,
  nativePrices: Record<string, number>
): string {
  const walletInfo = wallets
    .map((w) => {
      const chain = w.chain ?? "stacks:mainnet";
      const symbol = chain.startsWith("base") || chain.startsWith("celo") || chain.startsWith("ethereum") || chain.startsWith("robinhood") ? "ETH" : chain.startsWith("solana") ? "SOL" : "STX";
      return `#${w.id} ${w.address.slice(0, 10)}... [${chain}] balance: ${w.balance.toFixed(4)} ${symbol}`;
    })
    .join("\n");

  const priceEntries = Object.entries(nativePrices);
  const benchmarks = priceEntries.length > 0
    ? priceEntries.map(([symbol, price]) => `${symbol}: $${price > 0 ? price.toFixed(4) : "unknown"}`).join(", ")
    : "unknown";

  return `You are an autonomous multi-chain trading agent named "${agent.name}".

Context: ${agent.context}
Config: ${JSON.stringify(config)}
Current state: ${JSON.stringify(state)}
Native Token Price Benchmarks: ${benchmarks}

Wallets:
${walletInfo}

Supported Networks & DEXs:
- Stacks (ALEX & Bitflow): STX, USDCx, USDA, ALEX, WELSH, DIKO
- EVM Networks — Ethereum, Base, Celo, Robinhood (Uniswap/DEXs): ETH, USDC, WETH, VIRTUAL, CELO
- Solana (Raydium): SOL, USDC, BONK

Rules:
- Never trade more than ${config.maxPositionPct ?? 25}% of a wallet's balance in one trade
- If token prices are unknown or market signals are ambiguous, prefer "hold"
- Diversify across available tokens on the wallet's network
- Respond ONLY with valid JSON, nothing else:

{
  "action": "trade" | "hold",
  "reason": "brief explanation",
  "trade": {
    "walletId": number,
    "tokenIn": "STX",
    "tokenOut": "USDCx",
    "amountIn": 1.0,
    "direction": "BUY" | "SELL",
    "reason": "why"
  }
}`;
}
