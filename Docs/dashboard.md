---
title: Web Dashboard
category: Interfaces
order: 4
---

# Web Dashboard

The web dashboard is your command center for portfolio analytics, strategy configuration, and trade execution. Every page is accessible from the sidebar navigation.

## Navigation

The sidebar (left) lists all pages:

| Page | Icon | Purpose |
|------|------|---------|
| Dashboard | 📊 | Overview: portfolio value, bot status, recent trades, AI chat |
| Portfolio | 🥧 | Allocation charts, PnL/volume TradingView charts, per-wallet tabs |
| Wallets | 💼 | Create, import, reveal, delete Stacks wallets |
| Trade | 🔄 | Execute token swaps with quote preview |
| Trades | 📋 | Full trade history with status and filtering |
| Limit Orders | ⏰ | Create and manage buy/sell limit orders |
| Agents | 🤖 | AI trading agents with embedded strategies |
| Tokens | 🚫 | Token explorer and block list |
| Settings | ⚙️ | Risk parameters, slippage, position limits |
| Account | 👤 | Profile, email verification, password change, theme |

## Dashboard

The Dashboard gives you a quick snapshot:

- **Portfolio Value** — total balance across all wallets, with quick action buttons (Trade, Portfolio, Agents)
- **AI Command Bar** — type natural language commands (works the same as Telegram NL)
- **Stat Cards** — bot status, active trades, confirmed today, daily PnL
- **Recent Trades Table** — last 8 trades with direction, amounts, and status

The auto-refresh toggle at the top controls how often data updates. Toggle it on to enable periodic polling.

## Portfolio Page

The Portfolio page is your analytics hub, powered by TradingView Lightweight Charts:

- **Wallet Tabs** — switch between "All Wallets" (aggregated) and individual wallet views
- **Portfolio Value Hero** — total balance with wallet count and trade volume
- **Allocation Pie Chart** — visual breakdown of how your balance is distributed across wallets
- **Cumulative PnL** — TradingView area chart showing profit/loss over time
- **Daily Volume** — TradingView histogram showing trade volume per day
- **Wallet Breakdown Cards** — per-wallet cards with address and balance

The charts respond to the theme toggle — light and dark modes are fully supported.

## AI Command Bar

The chat input bar on the Dashboard and Agents pages lets you type in plain English:

- **Trading**: "buy 10 STX for sUSDT"
- **Navigation**: "show my limit orders" or "take me to agents"
- **Settings**: "set max position to 25%"
- **Info**: "how do I import a wallet?" or "hello"

The AI response appears below the input bar and auto-dismisses after 8 seconds. For trade commands, the wallet is auto-detected.

## Theme Toggle

Click **Light Mode / Dark Mode** at the bottom of the sidebar (or the sun/moon icon on mobile) to switch themes. Your preference is saved to localStorage and persists across sessions. If you've never set a preference, the system default is used (detected from your OS).
