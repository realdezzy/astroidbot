---
title: Token Discovery & Market Screener
category: User Features
order: 8
---

# Token Discovery & Market Screener

The **Token Discovery** page (`/tokens`) is AstroidBot's live market screener. It monitors liquidity pools and swap activity across all supported chains, helping you discover trending tokens, spot price breakouts, and trade assets instantly.

---

## Key Features

- **🌐 Multi-Chain Aggregation**: View tokens from Solana, Base, Stacks, Celo, Ethereum, and Robinhood in one unified table.
- **📊 Real-Time Metrics**: Monitor live price (USD), 24h price change %, 24h volume, liquidity depth, and market cap.
- **⚡ Filter & Search**: Filter by chain, sort by highest volume or biggest gainers, or search by token symbol and contract address.
- **📈 Interactive TradingView Charts**: Click any token to view high-resolution TradingView OHLCV candlestick charts.
- **🎯 One-Click Deep-Link Trade**: Click the **Trade** button on any token card to jump straight into prefilled trade execution with optimal DEX routing.

---

## How to Use Token Discovery

1. Click **Token Discovery** in the top navigation bar or go to `/tokens`.
2. Use the **Chain Filter Chips** to isolate a specific network (e.g. Solana or Base) or select **All Chains**.
3. Use the search bar to find tokens by symbol (e.g. `SOL`, `USDC`, `STX`) or contract address.
4. Click on any token row to open the **Token Detail View** (`/tokens/:chainId/:contractAddress`).
5. Review the chart, market metrics, and click **Trade Token**. The system automatically preselects your compatible wallet and opens the trade preview screen.
