---
title: Autonomous AI Agents
category: User Features
order: 7
---

# Autonomous AI Agents

AI Agents are intelligent background workers in AstroidBot. They analyze technical indicators, monitor price charts, and manage your assigned trading strategies.

---

## Agent Operating Modes

Each AI Agent can operate in one of three modes:

### 1. Off Mode
- The AI Agent does not generate independent trading signals or LLM market analysis.
- It purely executes assigned deterministic strategies (like scheduled DCA) on their strict timetable.

### 2. Advisor Mode (Recommended for Starters)
- The Agent actively analyzes live market indicators (RSI, Moving Averages, Pool Liquidity) and logs trade suggestions.
- **No real trades are executed autonomously**. Suggestions appear in your notification feed as actionable recommendations with one-click approval buttons.

### 3. Autonomous Mode
- The Agent operates with full decision-making authority within your strict safety limits.
- When market analysis identifies high-conviction trading opportunities, the Agent automatically executes trades on your designated wallet.

---

## Creating & Assigning Agents

1. Navigate to **Agents** in the Web Dashboard.
2. Click **Create AI Agent**.
3. Name your Agent and select its initial operating mode.
4. Assign specific **Trading Strategies** to the agent.
5. Set **Per-Trade Spend Limits** and **Daily Stop-Loss Limits**.
6. Save and activate your Agent.

---

## Agent Security & Safeguards

- **Hard Spend Caps**: Agents cannot exceed the maximum position size configured in your account settings.
- **Risk Override**: If total daily losses reach your configured stop-loss, all autonomous agents are instantly paused.
- **Activity Logs**: Every decision, prompt evaluation, and execution attempt is logged transparently in your Agent Activity feed.
