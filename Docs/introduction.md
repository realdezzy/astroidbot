---
title: Introduction to AstroidBot
category: Overview
order: 1
---

# Introduction to AstroidBot

AstroidBot is your AI-powered trading companion on the Stacks blockchain. It automates trading through Telegram, a web dashboard, and autonomous AI agents — so you can trade smarter without staring at charts all day.

## What Can AstroidBot Do?

- **Trade automatically** — set up strategies that run on schedule (rebalance, DCA, grid, sniper, copy)
- **Execute swaps** — buy and sell tokens instantly via Telegram or the web dashboard
- **Place limit orders** — set a target price and walk away; the bot executes when the market hits it
- **Run AI agents** — let an LLM analyze the market and suggest or execute trades autonomously
- **Manage wallets** — generate, import, and track multiple Stacks wallets securely
- **Ask in plain English** — type "buy 5 STX for sUSDT" or "how's my portfolio?" and the AI handles it

## Two Ways to Use AstroidBot

### 1. Telegram Bot
The Telegram bot is your quick-access control center. Use it to:
- Run trades on the go
- Check your portfolio balance
- Create and cancel limit orders
- Manage AI agents (run, toggle, delete)
- Ask natural language questions like "show my recent trades"

All Telegram screens use inline buttons — tap to navigate, no typing commands for most actions.

### 2. Web Dashboard
The web dashboard is your analytics and strategy headquarters. Use it to:
- View TradingView financial charts (PnL, volume, allocation)
- Create and manage trading strategies with detailed configuration
- Set up AI agents and assign strategies to them
- Execute detailed trades with quote previews
- Manage wallet keys and settings

## Key Concepts

### Wallets
Every trade needs a wallet. When you first sign up, AstroidBot automatically creates one. You can add more wallets (generate new keys or import existing ones). All private keys are encrypted with AES-256-GCM and never exposed in plaintext.

### Strategies vs Agents
- **Strategy** — a deterministic trading rule (e.g. "buy 1 STX of sUSDT every hour"). Configure it once, it runs on schedule.
- **Agent** — an AI-powered worker that can run multiple strategies AND make its own decisions. Agents have three modes:
  - **Off** — runs assigned strategies only, no AI decisions
  - **Advisor** — logs AI analysis but doesn't trade (safe preview)
  - **Autonomous** — executes AI decisions alongside strategies

### DEX Routing
AstroidBot automatically finds the best price across available DEXs (ALEX, Bitflow, Velar, Faktory) for every trade. You don't need to know which exchange to use — the bot picks the best route.

## Next Steps
1. [Set up your account and link Telegram](/Docs/getting-started)
2. [Explore the Telegram bot](/Docs/telegram-bot)
3. [Browse the web dashboard](/Docs/dashboard)
4. [Create your first strategy](/Docs/strategies)
