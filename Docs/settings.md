---
title: Settings & Configuration
category: User Features
order: 14
---

# Settings & Risk Configuration

AstroidBot includes flexible risk controls to safeguard your capital across all trading activities.

---

## Risk Parameters

You can adjust your risk parameters at any time from the Web Dashboard (**Settings**) or Telegram (**⚙️ Settings**):

| Setting | Description | Recommended Range | Default |
|---|---|---|---|
| **Slippage Tolerance** | Maximum acceptable price movement between quote time and execution block. | 0.1% – 3.0% | 0.5% |
| **Max Position Size (%)** | Maximum percentage of a wallet's balance to allocate to a single trade. | 5% – 50% | 25% |
| **Daily Loss Limit (%)** | Maximum acceptable daily drawdown. All trading bots pause if daily loss hits this cap. | 1.0% – 15.0% | 5.0% |
| **Rebalance Threshold (%)** | Portfolio drift percentage required to trigger automatic rebalancing. | 1.0% – 5.0% | 2.0% |

---

## Per-Chain Overrides & Gas Sponsorship

- **Chain-Specific Slippage Overrides**: You can set individual slippage limits per blockchain (e.g. `0.3%` on Solana vs `1.0%` on Stacks) to account for differing pool dynamics.
- **Gas Sponsorship Control**: On supported EVM networks (such as Base), account abstraction gas sponsorship can be enabled or toggled per chain.

---

## Account Management

Go to **Account** in the Web Dashboard sidebar to:
- Change your account password
- Link or unlink your Telegram profile
- Link your X or Farcaster social trading accounts
- Toggle interface color theme (Dark Mode / Light Mode)
