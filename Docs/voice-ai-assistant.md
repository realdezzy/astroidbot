---
title: Voice & AI Command Assistant
category: User Features
order: 3
---

# Voice & AI Command Assistant

AstroidBot includes a built-in AI Voice and Natural Language Command Engine. Instead of navigating multiple pages or filling out complex trade forms, you can instruct AstroidBot using plain speech or natural text commands.

---

## Key Capabilities

- **🎙️ Speech-to-Text Recognition**: Click the microphone icon in the Web Assistant terminal to speak commands directly.
- **⚡ Zero-Latency Command Parsing**: Core trading, navigation, and portfolio queries are parsed instantly with built-in deterministic intent recognition.
- **🧠 Natural Language Fallback**: Complex prompts are processed by our LLM orchestration engine to extract token symbols, trade amounts, target prices, and execution conditions.
- **🛡️ Safety-First Confirmation**: All financial trades parsed by the AI present a clear confirmation card before submitting transactions to the blockchain.

---

## Example Commands You Can Use

### 1. Swaps & Instant Execution
- *"Buy 50 USDC worth of SOL on Solana"*
- *"Swap 10 STX to USDCx on Bitflow"*
- *"Sell half of my ETH on Base"*

### 2. Conditional & Limit Orders
- *"Set a limit order to buy STX when price drops below $1.40"*
- *"Sell 100 USDC of SOL if price reaches $220"*
- *"Swap 500 USDC to STX on Bitflow when 1-hour RSI drops below 30"*

### 3. Portfolio & Market Queries
- *"What is my current portfolio balance across all chains?"*
- *"Show me my open limit orders"*
- *"Which tokens are trending on Solana today?"*
- *"How is my DCA strategy performing?"*

### 4. Navigation & Bot Control
- *"Open my wallets page"*
- *"Pause my autonomous AI trading agent"*
- *"Show my recent trade history"*

---

## How to Use Voice & AI Assistant

### On Web Dashboard
1. Look for the **AI Assistant Bar** at the top of the **Dashboard** page or press `Ctrl + K` (or `Cmd + K`).
2. Type your command in plain English or click the **Microphone icon** to speak.
3. AstroidBot parses your input and displays the parsed intent preview card.
4. Review the details and click **Confirm & Execute**.

### On Telegram Bot
1. Open your chat with `@AstroidBot`.
2. Send a voice message or type a natural text message directly into the chat window.
3. The bot parses your voice/text input and responds with an interactive button card to confirm the action.

---

## Tips for Best Results

- **Specify Chains & Assets Clearly**: Mentioning the chain or specific token symbol (e.g. *"on Base"* or *"SOL"*) ensures precise route selection.
- **Use Standard Percentages**: Phrases like *"sell 50%"* or *"buy with 25% of my balance"* automatically calculate exact token amounts based on your live wallet holdings.
- **Review Confirmation Cards**: Always verify the parsed amount, target DEX route, and token symbol on the confirmation popup before finalizing transactions.
