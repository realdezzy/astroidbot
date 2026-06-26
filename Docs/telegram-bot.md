---
title: Telegram Bot
category: Interfaces
order: 3
---

# Telegram Bot Guide

The Telegram bot is your pocket trading terminal. This guide covers every screen, command, and shortcut.

## Getting Started

Find the bot on Telegram (your admin will provide the handle, e.g. `@migoTestBankbot`) and send `/start`. This registers your account and provisions your first wallet automatically.

## Main Menu

The main menu appears when you send `/start` or tap **🏠 Home** from any screen.

It shows your portfolio value, wallet count, active orders, strategy count, and points. Below the summary, you'll find navigation buttons:

| Button | What It Does |
|--------|-------------|
| 📊 Portfolio | View token balances across all wallets |
| 💼 Wallets | Create, import, reveal, delete wallets |
| 📈 Trades | View recent trade history |
| 📋 Limit Orders | View and create limit orders |
| 🛒 Quick Trade | Execute a token swap |
| 🤖 Agents | Manage AI trading agents |
| ⚙️ Settings | Adjust risk parameters |
| 📧 Email / Link Email | Connect an email for web dashboard access |

Every sub-screen has **← Back** and **🏠 Home** buttons. Back returns to the previous screen, Home returns to the main menu. All navigation edits the existing message — no duplicate messages cluttering the chat.

## Quick Trade Flow

Execute a swap in 4 taps:

1. **Tap 🛒 Quick Trade** → pick a token from the 16 available tokens (e.g. sUSDT)
2. **Choose direction** — 🟢 BUY (spend STX to get the token) or 🔴 SELL (sell the token for STX)
3. **Type the amount** — reply with a number like `5.0` (STX amount to spend/receive)
4. **Confirm** — review the quote: estimated output, fee, price impact, wallet used. Tap **✅ Confirm Trade** to execute.

The trade is enqueued to the BullMQ worker and broadcast to the Stacks network.

## Limit Orders

### Viewing Orders
Tap **📋 Limit Orders** to see all active orders with their direction, amount, and target price. Each order has a **❌ Cancel** button.

### Creating an Order
1. Tap **📋 Limit Orders** → **➕ Create**
2. Pick the token you want to buy/sell
3. Choose BUY or SELL
4. Enter the amount
5. Enter the target price in USD
6. Review and tap **✅ Place Order**

The bot monitors prices every cycle and executes when the target price is hit.

## Wallet Management

### View Wallets
Tap **💼 Wallets** to see all your wallets with addresses and balances.

### Create Wallet
Tap **➕ New** — generates a new Stacks keypair and stores it encrypted in the database.

### Import Wallet
Tap **📥 Import** → paste your Stacks private key → the bot derives the address and stores it encrypted.

### Reveal Private Key
Tap 🔑 next to a wallet. For security reasons, plaintext private key reveals are blocked inside the Telegram interface to prevent chat log leaks. Instead, the bot will show a security warning and redirect you to the secure Web Dashboard `/wallets` page to reveal your key.

### Delete Wallet
Tap **🗑 Delete** → enter the wallet ID number to confirm.

## Managing AI Agents

### View Agents
Tap **🤖 Agents** to see all your agents with their active status, AI mode, strategy count, and last run time. Each agent has three buttons:

| Button | Action |
|--------|--------|
| ▶ Run | Trigger one agent cycle — executes strategies and optionally the AI overlay |
| ⏸ Pause / ✅ Activate | Toggle the agent on or off |
| 🗑 | Delete the agent permanently |

### Text Shortcuts
You can also type these directly instead of using buttons:
- `/run_1` — run agent #1
- `/toggle_1` — toggle agent #1 on/off
- `/del_1` — delete agent #1
- `/aimode_1_autonomous` — set agent #1 to autonomous mode (also: `off`, `advisor`)

## Portfolio & Trades

### View Portfolio
Tap **📊 Portfolio** to see each wallet's token balances with USD values, total portfolio value, and 24h PnL.

### View Trade History
Tap **📈 Trades** to see the last 20 trades with direction (🟢 BUY / 🔴 SELL), amounts, and status (✅ confirmed, ⏳ pending, ❌ failed).

## Settings

Tap **⚙️ Settings** to adjust:
- **Slippage** (10-1000 bps) — max acceptable price movement
- **Max Position** (1-100%) — max % of wallet to use per trade
- **Daily Loss** (0.5-25%) — halt if daily losses exceed this
- **Rebalance Threshold** (0.5-10%) — trigger rebalancing at this drift

Use the ◀ and ▶ buttons to adjust each value, or use natural language: _"set slippage to 200"_

## Natural Language Commands

You don't need to remember commands. Just type naturally:

| You say | Bot does |
|---------|----------|
| "buy 10 STX for sUSDT" | Executes a BUY trade |
| "show my portfolio" | Opens portfolio screen |
| "how do I create a wallet?" | Explains wallet creation |
| "what can you do?" | Lists platform features |
| "take me to the agents page" | Navigates to agents screen |
| "set max position to 30%" | Updates max position settings |
| "hello" | Greets you and explains features |

## Admin Commands

If you're an admin (configured via `TELEGRAM_ADMIN_IDS`), you also have:

| Command | What It Does |
|---------|-------------|
| `/halt` | Pause all trading |
| `/resume` | Resume trading |
| `/stats` | Show total users, wallets, trades, uptime |
| `/users` | List last 10 users |
| `/user <id>` | Show details for a specific user |
| `/disable <id>` | Disable a user account |
| `/enable <id>` | Enable a user account |
| `/points <id> <amount>` | Add points to a user |
| `/broadcast <message>` | Send message to all Telegram users |

## Commands Reference

| Command | Description |
|---------|-------------|
| `/start` | Main menu |
| `/help` | Full command list |
| `/trade` | Quick trade flow |
| `/portfolio` | View portfolio |
| `/wallets` | Wallet management |
| `/trades` | Trade history |
| `/orders` | Limit orders |
| `/agents` | AI agents |
| `/settings` | Risk settings |
| `/ai` | AI assistant (opens agents) |
| `/link_email` | Link email for web access |
| `/cancel` | Abort any active input flow |
