---
title: Wallets
category: Features
order: 5
---

# Wallet Management

AstroidBot manages your wallets across every chain this deployment runs. All private keys are encrypted at rest with AES-256-GCM before storage.

## A wallet belongs to one chain

This is the thing to know before anything else. A wallet is created *on* a
chain, holds that chain's assets, and cannot be used on another — a Base wallet
cannot hold STX, and a Stacks wallet cannot trade on Solana. Create one per
chain you want to trade.

Both interfaces therefore ask which chain **before** generating or importing
anything: the chain decides which adapter derives the address, and the answer
is permanent for that wallet's funds. The Wallets page also shows which enabled
chains you have no wallet on yet, with a one-click create for each.

## Types of Wallets

- **Auto-generated**: Created automatically when you sign up via Telegram or the web
- **Generated**: You can create additional wallets with fresh keypairs, on any enabled chain
- **Imported**: Import an existing private key you already own, on the chain it belongs to

## Viewing Wallets

### Web
Go to **Wallets** in the sidebar. Each wallet is shown as a card with:
- Wallet name and a badge for its chain
- Shortened address with copy button
- Current balance, in that chain's native asset
- **🔑 Reveal Key** and **🗑 Delete** buttons

### Telegram
Tap **💼 Wallets** on the main menu. Wallets are grouped by chain, each balance
shown in its own chain's native asset. Buttons:
- **➕ New** — generate a fresh wallet
- **📥 Import** — import an existing key
- **🗑 Delete** — remove a wallet
- **🔑 Reveal** — show key (with confirmation)
- **🔄 Refresh** — update balances

## Creating a New Wallet

### Web
1. Go to **Wallets** page
2. Click **➕ New Wallet**
3. Pick the chain
4. A keypair for that chain is generated server-side, encrypted, and stored
5. The new wallet appears in your list, badged with its chain

### Telegram
Tap **💼 Wallets** → **➕ New** → pick the chain → the wallet is created and
confirmed with its address and an explorer link.

## Importing an Existing Wallet

### Web
1. Go to **Wallets** page
2. Click **📥 Import**
3. Pick the chain the key belongs to — the field then tells you the format that
   chain expects (hex on Stacks, `0x`-prefixed hex on EVM, base58 on Solana)
4. Paste the key and click **Import** — the chain's adapter derives the address
   and the key is encrypted

### Telegram
Tap **💼 Wallets** → **📥 Import** → pick the chain → paste the private key →
wallet is imported with confirmation.

> The same key material imported on two chains is two legitimately distinct
> wallets, and both are allowed. Duplicate detection is scoped to the chain
> family for exactly that reason.

## Revealing a Private Key

**⚠️ Security Warning**: Your private key is the master key to your wallet. Anyone with it can steal your funds. Only reveal it if absolutely necessary, and store it securely.

### Web
1. Go to **Wallets** page
2. Click **🔑 Reveal Key** on a wallet card
3. Enter your account password to confirm
4. The key is shown in the modal — copy it and close immediately

### Telegram
1. Tap **💼 Wallets** → **🔑 Reveal** next to a wallet
2. The bot blocks plaintext reveals in chat for security. It displays a warning and a secure link to the Web Dashboard `/wallets` page to reveal the key.

## Deleting a Wallet

### Web
Click **🗑 Delete** on a wallet card. You can't delete your last remaining wallet.

### Telegram
Tap **💼 Wallets** → **🗑 Delete** → enter the wallet ID number to confirm.

## Wallet Security

- Private keys are encrypted with **AES-256-GCM** using a 32-byte key from your environment configuration
- Keys are never stored in plaintext on disk
- The reveal operation requires password re-authentication
- Wallet operations use Redis-based distributed locking to prevent concurrent access
- Transaction signing happens server-side — your key never leaves the secure environment
