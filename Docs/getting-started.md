---
title: Getting Started
category: Overview
order: 2
---

# Getting Started

This guide walks you through setting up your AstroidBot account from scratch.

## 1. Create an Account

### Via Web Dashboard
1. Open the web dashboard at [here](https://astroidbot.xyz/dashboard)
2. Click **Login** (top right)
3. Switch to the **Register** tab
4. Enter your email and a password (8+ characters, must include letters and numbers)
5. Click **Register**
6. Check your email for a verification link and click it

### Via Telegram
1. Open Telegram and search for the bot (ask your admin for the username, e.g. `@migoTestBankbot`)
2. Send `/start` — this creates your account automatically
3. To link an email (so you can also use the web dashboard), send `/link_email` and follow the prompts

## 2. Fund Your Wallet

AstroidBot automatically creates your first wallet when you sign up. Find its address:

**Via Telegram:** Tap **💼 Wallets** on the main menu — your wallet address and balance are shown there.

**Via Web:** Go to **Wallets** in the sidebar — each wallet card shows the address with a copy button.

Send STX (Stacks native token) to this address from any Stacks wallet or exchange. The balance will appear in AstroidBot after the transaction confirms on-chain (typically ~1 minute).

## 3. Explore the Bot

### Telegram Quick Tour
Send `/start` to see the main menu with buttons:
- **📊 Portfolio** — current balances across all wallets
- **💼 Wallets** — create, import, reveal, delete wallets
- **📈 Trades** — recent trade history
- **📋 Limit Orders** — view and manage limit orders
- **🛒 Quick Trade** — execute a swap
- **🤖 Agents** — manage AI trading agents
- **⚙️ Settings** — risk parameters (slippage, position limits)

### Web Dashboard Tour
The sidebar has links to every page:
- **Dashboard** — overview with portfolio value, bot status, recent trades
- **Portfolio** — allocation charts, PnL performance, per-wallet breakdown
- **Wallets** — wallet management (create, import, reveal keys)
- **Trade** — swap tokens with quote preview
- **Trades** — full trade history with filters
- **Limit Orders** — create and manage limit orders
- **Agents** — AI agents and their strategies
- **Tokens** — token explorer and block list
- **Settings** — risk, slippage, position configuration
- **Account** — email, password, linked accounts

## 4. Configure Your Settings

Before trading, review your risk settings:

**Via Telegram:** Tap **⚙️ Settings** on the main menu. Use the +/- buttons to adjust:
- **Slippage** — maximum acceptable price movement (in basis points, 100 = 1%)
- **Max Position** — maximum percentage of your wallet to use per trade
- **Daily Loss** — stop trading if daily losses exceed this percentage
- **Rebalance** — trigger rebalancing when allocation drifts by this percentage

**Via Web:** Go to **Settings** in the sidebar. Same options with input fields.

## 5. Try Your First Trade

**Via Telegram:**
1. Tap **🛒 Quick Trade** on the main menu
2. Pick a token (e.g. sUSDT)
3. Choose **BUY** (spend STX to get sUSDT) or **SELL** (sell sUSDT for STX)
4. Type the amount (e.g. `5.0`)
5. Review the quote (shows estimated output, fee, price impact)
6. Tap **✅ Confirm Trade**

**Via Web:**
1. Go to **Trade** in the sidebar
2. Select wallets to use (checkbox list)
3. Pick input and output tokens
4. Enter the amount
5. Review the quote preview
6. Click **Execute Trade**

## 6. Set Up Automation

Now that you can trade manually, try automating:
1. [Create a trading strategy](/Docs/strategies) — DCA, grid, sniper, etc.
2. [Set up an AI agent](/Docs/agents) to run strategies on schedule
3. [Place limit orders](/Docs/limit-orders) for hands-off execution

## Need Help?

- On Telegram: send `/help` for the command list, or type any question naturally (e.g. "how do I create a wallet?")
- On the web dashboard: use the AI chat bar at the top of the Dashboard page
