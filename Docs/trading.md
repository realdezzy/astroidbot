---
title: Multi-Chain Swaps & Trading
category: User Features
order: 4
---

# Multi-Chain Swaps & Trading

AstroidBot provides high-speed DEX aggregation across major blockchain networks, automatically routing your orders through the deepest liquidity pools for optimal pricing and minimum price impact.

---

## Supported Ecosystems & DEX Routers

| Chain | Network ID | Supported DEX Routers | Native Asset | Stablecoin |
|---|---|---|---|---|
| **Solana** | `solana:mainnet` | Jupiter Aggregator | SOL | USDC |
| **Stacks** | `stacks:mainnet` | ALEX, Bitflow, Velar, Faktory | STX | USDCx |
| **Base** | `base:mainnet` | Uniswap V3 | ETH | USDC |
| **Celo** | `celo:mainnet` | Ubeswap / Uniswap V3 | CELO | cUSD |
| **Ethereum** | `ethereum:mainnet` | Uniswap V3 | ETH | USDC |
| **Robinhood** | `robinhood:mainnet` | Uniswap V3 | ETH | USDC |

---

## Executing a Swap on Web

1. Go to **Trade** in the Web Dashboard sidebar.
2. Select your target **Chain** using the chain selector chips.
3. Choose your **Wallet** for that specific chain.
4. Select your **Input Asset** (e.g. USDC) and **Output Asset** (e.g. SOL or STX).
5. Enter the amount to trade, or click a quick-percentage chip (`25%`, `50%`, `75%`, `100%`).
6. Review the **Quote Preview**:
   - **Exchange Rate**: Current conversion ratio.
   - **Price Impact**: Percentage shift in pool price caused by your order size.
   - **Routing DEX**: The DEX provider handling the trade execution.
   - **Network Gas Fee**: Estimated transaction fee (sponsored where applicable).
   - **Minimum Received**: Guaranteed output accounting for slippage settings.
7. Click **Execute Trade**. Once broadcast, your transaction hash and live explorer link will be displayed.

---

## Executing a Swap on Telegram

1. Tap **🛒 Quick Trade** on the Telegram main menu.
2. Select your desired chain from the interactive menu.
3. Choose your token pair from the list or send a token symbol/address.
4. Select **BUY** or **SELL**.
5. Tap an amount preset button (`25%`, `50%`, `75%`, `Max`) or type a custom number.
6. Review the quote summary card and tap **✅ Confirm Trade**.

---

## Automatic Native Token Wrapping

When trading native assets like **ETH** or **CELO** on EVM networks, AstroidBot automatically handles wrapping into **WETH** / **WCELO** and unwrapping back to native assets as required by Uniswap V3 smart contracts in a single atomic transaction. You do not need to wrap your tokens manually beforehand.

---

## Slippage & Price Impact Protection

- **Slippage Tolerance**: Defaults to `0.5%`. If market price moves unfavorably by more than your set tolerance during execution, the transaction fails safely to protect your funds.
- **Price Impact Warnings**: If an order size exceeds local pool depth resulting in a price impact greater than `3.0%`, AstroidBot highlights a warning banner before confirmation.
- **Quote Expiration**: Quotes expire after 30 seconds to prevent execution against stale market rates.
