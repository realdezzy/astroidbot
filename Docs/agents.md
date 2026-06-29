---
title: AI Agents
category: Features
order: 8
---

# AI Trading Agents

Agents are autonomous workers that execute strategies and optionally make their own AI-driven trading decisions.

## What is an Agent?

An agent is a container that:
1. Holds one or more **trading strategies** (portfolio rebalance, grid, DCA, sniper, copy)
2. Has an **AI mode** that controls how much autonomy the AI has
3. Runs on the bot cycle (every 60 seconds) — executing strategies and evaluating market data

## AI Modes

Each agent operates in one of three modes:

| Mode | Strategy Execution | AI Decision-Making | AI Trade Execution |
|------|-------------------|-------------------|-------------------|
| **Off** | ✅ Runs all assigned strategies | ❌ No AI calls | ❌ No AI trades |
| **Advisor** | ✅ Runs all assigned strategies | ✅ AI analyzes market and logs decisions | ❌ AI doesn't execute trades |
| **Autonomous** | ✅ Runs all assigned strategies | ✅ AI analyzes market | ✅ AI executes its own trades |

### Off Mode
Pure deterministic trading. The agent runs whichever strategies you've assigned, exactly as configured. No LLM calls, no AI decisions.

**Use when:** You want simple automation with predictable behavior.

### Advisor Mode
The agent runs strategies AND consults the AI for additional analysis. The AI's decisions are logged (visible in the agent card and saved as `AIRecommendation` records), but trades are NOT automatically executed.

**Use when:** You want to test AI strategies without risking capital. Review the AI's recommendations and decide manually whether to act.

### Autonomous Mode
The agent runs strategies AND lets the AI execute its own trades. The AI receives real-time market data (STX price, wallet balances, portfolio composition) and can decide to BUY or SELL independently.

**Use when:** You trust the AI to make real-time decisions and want full automation.

## Creating an Agent

### Web
1. Go to **Agents** in the sidebar
2. Click **New Agent**
3. Enter a name (e.g. "ETH Band Trader")
4. Choose an **AI mode**:
   - **Off** — strategies only
   - **Advisor** — AI logs decisions
   - **Autonomous** — AI executes trades
5. Set **Max Position Per Trade** — caps how much of your wallet the AI can use in one trade (default 25%)
6. Click **Create Agent**

### Telegram
Agents are created via the web dashboard. On Telegram, tap **🤖 Agents** to view, run, toggle, and delete agents.

## Adding Strategies to an Agent

1. On the **Agents** page, expand an agent card (click its name)
2. Scroll to the **Strategies** section
3. Click **Add**
4. Choose a strategy type
5. Configure the parameters
6. Select wallets
7. Click **Add Strategy**

An agent can have multiple strategies. For example, one agent might run DCA on sUSDT AND a sniper strategy on new tokens simultaneously.

## Running an Agent

Agents run automatically on every bot cycle (every 60 seconds by default). You can also trigger a manual run:

### Web
Click the **▶ Run** button on any agent card. This runs one cycle immediately and shows the result (strategies executed, actions taken).

### Telegram
In the **🤖 Agents** screen, tap the agent's **▶ Run** button, or type `/run_1` (for agent #1).

## Monitoring Agent Activity

### Web
Expand an agent card to see:
- **AI Mode** selector — switch between Off, Advisor, Autonomous inline
- **Last AI Decision** — if the AI was consulted, the action and reasoning are displayed
- **Strategy list** — all assigned strategies with toggle/delete/info buttons
- **Run result** — after manual run, a temporary message shows what happened

### Telegram
Tap **🤖 Agents** to see each agent with:
- ✅ Active or ⏸ Paused status
- Strategy count and AI mode
- Last run time and actions count
- Inline buttons: ▶ Run, ⏸ Toggle, 🗑 Delete

## Agent Configuration

Each agent's `config` JSON can include:

| Parameter | Description | Default |
|-----------|-------------|---------|
| `maxPositionPct` | Max % of wallet balance per trade | 25 |
| `allowedTokens` | Array of token symbols the agent is allowed to trade | (all) |

The AI prompt for autonomous agents includes real-time STX price, wallet balances, and available tokens from the registered DEX registries.
