# Stacks Grant Proposal: Problem Statement

## The Gap in the Stacks Ecosystem

The Stacks ecosystem is experiencing rapid growth in decentralized finance (DeFi), driven by protocols like ALEX, Bitflow, and Velum. However, the ecosystem faces several critical limitations in trading infrastructure and user experience:

### 1. Absence of Automation and Advanced Order Types
Stacks DEXs rely entirely on manual, synchronous transaction execution. There is no native support for:
- Limit orders (buy/sell at specific price targets).
- Algorithmic strategies (DCA, grid trading, stop-loss/take-profit).
- Automated portfolio rebalancing.

Due to the lack of on-chain automated triggers, users must remain online to execute trades manually, which is highly inefficient.

### 2. High Transaction Friction and Fee Complexity
Executing transactions on Stacks involves navigating varying block confirmation times (anchor blocks vs. microblocks) and fluctuating transaction fees. For retail users, calculating optimal fees and slippage is a barrier to entry. There is no automated assistant to manage execution parameters or self-heal failed transactions.

### 3. Lack of Conversational AI Interfaces
Modern retail traders increasingly adopt conversational and natural-language interfaces for execution. The Stacks ecosystem currently lacks a unified assistant capable of translating simple English commands into secure, verified transactions.

---

## AstroidBot Solution

AstroidBot fills these gaps by providing:
1. **Automated Execution Engine**: An off-chain monitor combined with Stacks transaction building to execute limit orders and trading strategies automatically when conditions are met.
2. **AI-Powered Command Parsing**: An interface allowing users to converse with a trading agent to query balances, filter spam tokens, and execute orders.
3. **Transaction Self-Healing**: Automated fee adjustment and nonce tracking to handle congestion.
