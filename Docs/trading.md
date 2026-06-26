---
title: Trading
category: Features
order: 6
---

# Trading Tokens

Execute swaps between any supported Stacks tokens. AstroidBot automatically finds the best price across available DEXs (ALEX, Bitflow).

## Quick Trade — Web

1. Go to **Trade** in the sidebar
2. **Select wallets** — check the boxes for wallets you want to trade from (multi-wallet support)
3. **Pick tokens** — choose the input token (e.g. STX) and output token (e.g. sUSDT) from the searchable dropdowns
4. **Choose direction** — the swap arrow can be rotated to switch buy/sell direction
5. **Enter amount** — type how much of the input token to spend
6. **Review quote** — the quote card shows:
   - Estimated output amount
   - Fee (in bps and absolute value)
   - Price impact percentage
7. **Click Execute Trade** — the trade is sent to the background execution worker

## Quick Trade — Telegram

1. Tap **🛒 Quick Trade** on the main menu
2. Pick a token from the 16 available tokens
3. Choose 🟢 BUY (spend STX) or 🔴 SELL (receive STX)
4. Type the amount when prompted (e.g. `5.0`)
5. Review the confirm screen — shows estimated output, fee, price impact, wallet used
6. Tap **✅ Confirm Trade** to execute

## Trade Quote Preview

Before executing any trade, you can preview the expected result:

**Web**: Go to **Trade** page, enter amounts — the quote card updates live showing expected output, fee, and price impact.

The bot queries all registered DEXs and returns the best available route.

## Trade History

### Web
Go to **Trades** in the sidebar. View all historical trades with:
- Direction (BUY/SELL)
- Input and output amounts with token symbols
- Status: **CONFIRMED** (on-chain), **BROADCAST** (pending), **FAILED** (error)
- Fee amounts
- Transaction IDs

### Telegram
Tap **📈 Trades** on the main menu. Shows last 20 trades with direction, amounts, and status emojis.

## Supported Tokens

The bot supports all tokens available on ALEX DEX (typically 28+ tokens). Common pairs include:
- STX / sUSDT
- STX / ALEX
- STX / USDA
- STX / WELSH
- STX / DIKO

Token list is cached for 6 hours and refreshed automatically.

## Trade Execution Flow

Behind the scenes, every trade follows this pipeline:

1. **Risk Check** — validates against your daily loss limit, position size caps, and available balance
2. **DEX Routing** — queries all providers for the best price
3. **Payload Building** — constructs the Stacks contract call
4. **Signing** — decrypts wallet key, signs the transaction
5. **Broadcasting** — sends to Stacks RPC
6. **Confirmation** — polls the network for transaction status (up to 20 attempts, 30s apart)
7. **Notification** — you receive a Telegram alert (if linked) and the dashboard updates via WebSocket
