---
title: Limit Orders & Stop-Loss
category: User Features
order: 5
---

# Limit Orders & Stop-Loss

AstroidBot allows you to set automated **Limit Orders** and **Stop-Loss** triggers across all supported blockchains. Your funds remain safely in your custody until market conditions hit your exact price target.

---

## How Limit Orders Work

Unlike traditional centralized exchange limit orders that lock up your balance in an order book, AstroidBot's limit order engine monitors live DEX price feeds 24/7. When the market price satisfies your target condition, AstroidBot automatically constructs, signs, and executes the swap on your behalf.

---

## Order Types

1. **Buy Limit**: Triggers a buy order when the token price falls to or below your specified target.
2. **Sell Limit (Take-Profit)**: Triggers a sell order when the token price rises to or above your target.
3. **Stop-Loss**: Triggers a protection sell order if a token drops below a defined safety threshold, locking in profits or preventing catastrophic drawdowns.

---

## Creating a Limit Order

### On Web Dashboard
1. Go to **Limit Orders** in the sidebar.
2. Click **Create Limit Order**.
3. Select your target **Chain** and **Wallet**.
4. Choose the **Token Pair** (e.g. SOL / USDC).
5. Specify your **Target Price** and **Order Amount**.
6. Select **Expiry Duration** (1 Day, 7 Days, 30 Days, or Never).
7. Click **Submit Order**.

### Via Voice / AI Assistant
Simply tell the assistant:
- *"Set a limit order to buy 100 STX when price reaches $1.35"*
- *"Set a stop loss to sell my SOL if price drops below $180"*

---

## Managing Open Orders

You can monitor, edit, or cancel active limit orders at any time without network gas fees:
- **On Web**: Visit the **Limit Orders** table to view target price progress indicators, status badges, and one-click **Cancel** buttons.
- **On Telegram**: Tap **📋 Limit Orders** on the main menu to view active orders and cancel them with a single tap.
