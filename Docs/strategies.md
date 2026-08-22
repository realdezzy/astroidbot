---
title: Automated Strategies & Grid Bots
category: User Features
order: 6
---

# Automated Strategies & Grid Bots

AstroidBot provides quantitative trading algorithms that run continuously on your behalf. Whether you want to average into positions or profit from market volatility in a range, automated strategies keep your portfolio executing 24/7.

---

## Strategy Types

### 1. Grid Trading Bot
Grid trading places a ladder of buy and sell orders within a specified price range. As price fluctuates up and down, the bot buys low and sells high automatically, capturing steady profits from sideways volatility.
- **Lower Price**: Bottom boundary of trading range.
- **Upper Price**: Top boundary of trading range.
- **Grid Count**: Number of buy/sell levels within the grid.

### 2. Dollar-Cost Averaging (DCA)
DCA automatically buys a fixed dollar amount of a token at regular recurring intervals (e.g. $50 of SOL every day). This reduces the impact of short-term volatility and eliminates market timing stress.
- **Interval**: Daily, Weekly, or Bi-weekly.
- **Order Size**: Fixed amount per execution.

### 3. Token Sniper
Token Sniping automatically detects newly deployed token pools or liquidity additions across DEXs and places instant buy orders matching your predefined parameters.
- **Liquidity Floor**: Minimum pool liquidity required before sniping.
- **Max Buy Amount**: Upper limit per trade.

### 4. Copy-Trading
Follow top-performing wallets or social signals automatically, replicating trades proportionally based on your designated position size.

---

## Setting Up a Strategy

1. Go to **Strategies** in the Web Dashboard.
2. Click **Create Strategy**.
3. Choose your strategy template (**Grid**, **DCA**, **Sniper**, or **Copy**).
4. Select the target **Chain** and **Wallet**.
5. Configure parameters (Price boundaries, grid levels, trade sizes).
6. Assign an **AI Agent** (optional) to manage and monitor the strategy.
7. Click **Activate Strategy**.

---

## Monitoring Performance

Your active strategies display real-time analytics on the dashboard:
- Total executed cycles
- Total profit/loss (PnL) in USD and percentage
- Next scheduled execution timestamp
- One-click **Pause / Resume** and **Terminate** controls
