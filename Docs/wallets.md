---
title: Wallets
category: Features
order: 5
---

# Wallet Management

AstroidBot securely manages your Stacks wallets. All private keys are encrypted at rest with AES-256-GCM before storage.

## Types of Wallets

- **Auto-generated**: Created automatically when you sign up via Telegram or the web
- **Generated**: You can create additional wallets with fresh keypairs
- **Imported**: Import an existing Stacks private key you already own

## Viewing Wallets

### Web
Go to **Wallets** in the sidebar. Each wallet is shown as a card with:
- Wallet name
- Shortened address with copy button
- Current balance in STX
- **🔑 Reveal Key** and **🗑 Delete** buttons

### Telegram
Tap **💼 Wallets** on the main menu. Shows wallet list with addresses and balances. Buttons:
- **➕ New** — generate a fresh wallet
- **📥 Import** — import an existing key
- **🗑 Delete** — remove a wallet
- **🔑 Reveal** — show key (with confirmation)
- **🔄 Refresh** — update balances

## Creating a New Wallet

### Web
1. Go to **Wallets** page
2. Click **➕ Generate Wallet** button
3. A new Stacks keypair is generated server-side, encrypted, and stored
4. The new wallet appears in your list

### Telegram
Tap **💼 Wallets** → **➕ New** → a wallet is created instantly with a confirmation toast.

## Importing an Existing Wallet

### Web
1. Go to **Wallets** page
2. Click **📥 Import Wallet**
3. Paste your Stacks private key (hex format)
4. Click **Import** — the bot derives the address and encrypts the key

### Telegram
Tap **💼 Wallets** → **📥 Import** → paste the private key → wallet is imported with confirmation.

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
