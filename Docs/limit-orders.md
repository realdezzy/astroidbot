---
title: Limit Orders
category: Features
order: 9
---

# Limit Orders

Limit orders let you set a target price and walk away. The bot monitors prices every cycle and executes when your target is hit.

## How Limit Orders Work

1. You create an order specifying:
   - Which token to buy or sell
   - The amount
   - The target price (in USD)
2. On every bot cycle (every 60 seconds), the bot checks current prices
3. When the price meets your target, the bot builds the swap transaction and broadcasts it
4. The order is marked as filled and appears in your trade history

## Creating a Limit Order

### Web
1. Go to **Limit Orders** in the sidebar
2. Click **➕ Create** (or **➕ New Order**)
3. Fill in the form:
   - **Chain** — picked first. An order can only fill on the chain its wallet
     and pair live on, so this drives everything below it: the wallet list is
     filtered to that chain, the token pickers show only that chain's
     catalogue, and the default pair comes from the chain itself.
   - **Wallets** — one or more wallets *on that chain* to place the order from
   - **Direction** — BUY or SELL
   - **Token In** — the token you're spending
   - **Token Out** — the token you're buying
   - **Amount** — how much to spend
   - **Target Price (USD)** — the price at which to execute
4. Click **Create Order**

An order whose pair cannot route on the wallet's chain is rejected at creation
with the chain named, rather than stored and left to fail later. Target prices
are denominated in that chain's USD stablecoin.

### Telegram
1. Tap **📋 Limit Orders** on the main menu
2. Tap **➕ Create**
3. Pick the token you want to buy/sell
4. Choose BUY or SELL direction
5. Enter the amount
6. Enter the target price in USD
7. Review and tap **✅ Place Order**

## Managing Orders

### Viewing Active Orders
- **Web**: Go to **Limit Orders** page — all active orders shown in the table
- **Telegram**: Tap **📋 Limit Orders** — shows each order with direction, amount, and target price

### Canceling Orders
- **Web**: Click the **Cancel** button on any order in the table
- **Telegram**: Tap the **❌ Cancel** button next to any order

### Order Status
- **ACTIVE** — waiting for the target price to be reached
- **PENDING_FILL** — price condition met, trade executing
- **FILLED** — trade confirmed on-chain
- **CANCELLED** — manually cancelled

## Limit Order Execution

**Price Checking:**
The bot uses the USDCx price of the input token as a proxy for the real pair price. This works well for tokens that are directionally correlated with USDCx (the Stacks USD stablecoin). For exotic token pairs, the execution price may differ slightly from your target.

**Execution Conditions:**
- **BUY order**: executes when current price **≤** target price (buy when it drops to your target)
- **SELL order**: executes when current price **≥** target price (sell when it rises to your target)

**Expiry:**
Orders can have an optional expiry time. If the price target isn't reached by the expiry date, the order is automatically cancelled.

**Force After:**
Orders can optionally "force execute" after a certain time regardless of price — useful for ensuring a trade happens by a deadline.

## Fees

Each limit order execution incurs the standard DEX fee (typically 0.3% / 30 bps, depending on the route and platform used). This fee is shown in the trade history after execution.

## Multiple Wallets

Limit orders support multiple wallets. When creating via the web dashboard, you can select multiple wallets with the **MultiWalletSelect** component. The bot creates a separate order for each selected wallet.
