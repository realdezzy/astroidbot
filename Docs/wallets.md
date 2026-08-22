---
title: Wallets & Security
category: User Features
order: 11
---

# Wallets & Security

AstroidBot provides non-custodial wallet management across every supported blockchain ecosystem (Solana, Stacks, Base, Celo, Ethereum, Robinhood).

---

## Key Principles

1. **Chain-Specific Wallets**: A wallet belongs to a specific blockchain network. For example, a Solana wallet holds SOL and SPL tokens, while a Base wallet holds ETH and Base ERC-20 tokens.
2. **Non-Custodial Architecture**: Your private keys belong to you. Transaction signing happens securely on demand.
3. **AES-256-GCM Encryption**: All stored private key data is encrypted at rest using AES-256-GCM.

---

## Wallet Operations

### Creating a New Wallet
- **On Web**: Go to **Wallets**, click **➕ New Wallet**, select your target chain, and click **Create**.
- **On Telegram**: Tap **💼 Wallets > ➕ New**, select the chain, and confirm.

### Importing an Existing Wallet
You can import existing private keys:
- **EVM (Base, Celo, Ethereum, Robinhood)**: Expects `0x`-prefixed 64-character hex key.
- **Solana**: Expects Base58-encoded secret key.
- **Stacks**: Expects 64-character hex private key.

### Revealing Private Keys
To export a wallet key for use in external wallets (like Phantom or Metamask):
1. Go to **Wallets** in the Web Dashboard.
2. Click **🔑 Reveal Key** on the desired wallet card.
3. Re-enter your account password for security verification.
4. Copy your private key and store it safely offline.

---

## Security Best Practices

- Never share your private keys or password with anyone.
- Enable two-factor authentication (2FA) on your linked email account.
- Review your account slippage and daily loss limits regularly.
