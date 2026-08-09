---
title: Settings
category: Platform
order: 10
---

# Settings & Configuration

Configure your risk parameters, trading preferences, and account security.

## Risk Settings

These parameters control how the bot manages your trading risk. Change them at any time — they apply immediately to the next cycle.

### Web
Go to **Settings** in the sidebar.

### Telegram
Tap **⚙️ Settings** on the main menu. Use ◀ and ▶ buttons to adjust each value, or use natural language: _"set slippage to 200"_

### Parameters

| Setting | Description | Range | Default |
|---------|-------------|-------|---------|
| **Slippage (bps)** | Max acceptable price movement. If the price moves more than this between quote and execution, the trade is cancelled. | 10–1000 | 100 (1%) |
| **Max Position (%)** | Maximum percentage of wallet balance to use in a single trade. Prevents over-exposure. | 1–100 | 25% |
| **Daily Loss Limit (%)** | If daily losses exceed this percentage of portfolio value, further trades are halted. | 0.5–25 | 5% |
| **Rebalance Threshold (%)** | Minimum allocation drift to trigger portfolio rebalancing. | 0.5–10 | 2% |

### Which settings are per chain

Two layers, and which layer a setting lives in follows from what it bounds.

**Slippage is per chain.** A Stacks AMM and a Solana aggregator are not the same
trade at the same tolerance. The web Settings page lists every enabled chain
below the account default; a chain left on *Inherit* uses that default, and
clearing an override returns it to inheriting rather than pinning it at today's
value.

**Max position, daily loss limit and rebalance threshold are account-wide.**
They bound total exposure, so a per-chain copy would let someone running three
chains take three times the position they asked to be limited to.

**Gas sponsorship is per chain**, and only offered on chains that can sponsor
at all — ERC-4337 custody with a bundler and a paymaster key. Chains that
cannot are listed with the reason rather than hidden, so a missing toggle is
explained instead of mysterious.

> Per-chain preferences live in their own table. They previously shared one
> with the account settings, and toggling sponsorship for a second chain
> inserted a duplicate settings row carrying product defaults — after which
> which risk limits were enforced depended on which row the database returned
> first. If you are upgrading across that change, the migration keeps your
> configured row and carries every sponsorship choice across.

### When Settings Take Effect

Settings are checked at two points:
1. **At trade enqueue time** (strategy engine / personal trade cycle)
2. **At trade execution time** (the background execution engine — re-checks because market may have moved)

If a trade fails the pre-execution risk check, it's rejected and logged.

## Account Settings

### Web
Go to **Account** in the sidebar.

### Changing Password
1. Enter your current password
2. Enter your new password (8+ chars, 1 letter + 1 number)
3. Click **Change Password**

### Email Verification
If your email shows as unverified, you can request a new verification email from the Account page.

### Telegram Integration
- **Link Telegram**: If you signed up via email, you can link your Telegram account from the Account page using the Telegram Login Widget
- **Unlink Telegram**: You can disconnect your Telegram account if desired

### Theme
Toggle between **Light Mode** and **Dark Mode** from the sidebar (desktop) or the top bar (mobile). Your preference is saved locally.


