---
title: Trading Strategies
category: Features
order: 7
---

# Trading Strategies

Strategies are automated trading rules that run on a schedule. Configure them once and let the bot execute. Five strategy types are available — each suited to different market conditions and goals.

## Strategy Types

### Portfolio Rebalancing

Maintains target allocation weights across tokens.

**How it works:**
1. AI analyzes current market conditions and generates target weights
2. The bot compares current allocations to targets
3. When deviation exceeds the threshold, it executes buy/sell swaps to rebalance

**Best for:** Long-term holders who want to maintain a specific portfolio composition without manual intervention.

**Configuration:**
| Parameter | Description | Example |
|-----------|-------------|---------|
| Rebalance Threshold (%) | Minimum drift to trigger rebalance | 2% |
| Max Position (%) | Maximum wallet % per trade | 25% |

---

### Grid Market Making

Places buy and sell orders at fixed intervals around the current price.

**How it works:**
1. AI analyzes volatility and configures grid spread
2. The bot creates multiple price levels above (sell) and below (buy) the mid-price
3. When price crosses a level, a trade executes at that price
4. The grid auto-tightens during low volatility and widens during high volatility

**Best for:** Sideways/ranging markets where prices oscillate within a band.

**Configuration:**
| Parameter | Description | Example |
|-----------|-------------|---------|
| Token Pair | Trading pair (e.g. STX/sUSDT) | STX/sUSDT |
| Grid Levels | Number of buy/sell bands (3-10) | 5 |
| Spread (bps) | Price gap between grid levels | 30 |
| Max Position (%) | Maximum wallet % per trade | 25% |

---

### Dollar Cost Averaging (DCA)

Buys a fixed amount at regular intervals regardless of price.

**How it works:**
1. The bot tracks time since last DCA trade
2. When the interval is reached, it executes a buy for the configured amount
3. Repeats on schedule

**Best for:** Accumulating a token over time while smoothing out price volatility.

**Configuration:**
| Parameter | Description | Example |
|-----------|-------------|---------|
| From Token | Source token (usually STX) | STX |
| To Token | Target token to accumulate | sUSDT |
| Amount per Buy | How much to swap each interval | 1.0 |
| Interval (minutes) | Time between buys | 60 |

---

### Token Sniper

Auto-buys newly discovered tokens matching your watchlist.

**How it works:**
1. You provide a comma-separated list of token symbols to watch
2. The bot detects when these tokens appear in the ALEX swap list
3. Executes a buy for each new token (one-time only per token per wallet)

**Best for:** Getting early exposure to newly listed tokens on the Stacks DEX.

**Configuration:**
| Parameter | Description | Example |
|-----------|-------------|---------|
| Watch Tokens | Comma-separated tokens to watch | ALEX,WELSH,DIKO |
| Max Buy Amount | Max STX to spend per token buy | 1.0 |
| Slippage (bps) | Max acceptable price movement | 100 |

---

### Copy Trading

Mirrors trades from a target wallet address.

**How it works:**
1. The bot fetches the last 5 transactions from the target address
2. Filters for recent successful contract call transactions
3. Executes matching buy trades for tokens the target wallet acquired

**Best for:** Following the trading patterns of successful wallets.

**Configuration:**
| Parameter | Description | Example |
|-----------|-------------|---------|
| Target Address | Stacks address to mirror | SP...abc123 |
| Max Per Trade | Max STX to spend per copied trade | 10 |
| Min Liquidity ($) | Minimum pool liquidity to execute | 1000 |

---

## Creating a Strategy

### Web
1. Go to **Agents** page
2. Expand an agent card (by clicking its name)
3. Scroll to the **Strategies** section
4. Click **Add**
5. Choose a strategy type from the 5 options
6. Fill in the configuration fields (they change based on type)
7. Select wallets to assign
8. Click **Add Strategy**

### Strategy Lifecycle
- **Active** — runs on every bot cycle (usually every 60 seconds)
- **Paused** — saved but not executing; can be toggled back on
- **Deleted** — permanently removed

All strategies are assigned to an **Agent**. Strategies without an agent don't run on the scheduled cycle — they must be triggered manually.

## Monitoring Strategy Performance

### Web
On the **Agents** page, expand an agent card and click the **Info** button next to any strategy. This opens a detail modal showing:
- Strategy configuration
- Recent trades executed by this strategy
- PnL (profit and loss from confirmed trades)

### Telegram
Tap **🤖 Agents** to see each agent with its active strategy count, AI mode, and last run time.
