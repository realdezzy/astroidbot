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
   - **Wallet** — select which wallet to trade from
   - **Direction** — BUY or SELL
   - **Token In** — the token you're spending (e.g. STX)
   - **Token Out** — the token you're buying (e.g. sUSDT)
   - **Amount** — how much to spend
   - **Target Price (USD)** — the price at which to execute
4. Click **Create Order**

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
The bot uses the sUSDT price of the input token as a proxy for the real pair price. This works well for tokens that are directionally correlated with sUSDT (the Stacks USD stablecoin). For exotic token pairs, the execution price may differ slightly from your target.

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
