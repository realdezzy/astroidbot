---
title: Social Trading (X & Farcaster)
category: User Features
order: 9
---

# Social Trading (X & Farcaster)

AstroidBot allows you to execute trades directly from social media mentions on **X (formerly Twitter)** and **Farcaster**. Simply tag `@AstroidBot` with a trade command to initiate swaps on your linked account.

---

## Linking Your Social Handle

1. Go to **Settings > Account** in the Web Dashboard.
2. Click **Link Social Account** under X or Farcaster.
3. AstroidBot generates a unique one-time verification code.
4. Post or DM the code to confirm ownership of your social profile.
5. Once verified, your social handle is securely linked to your AstroidBot wallet.

---

## Social Execution Modes

### 1. Confirm-First Mode (Default & Safe)
- When you mention `@AstroidBot` in a post (e.g. `@AstroidBot buy 50 USDC of SOL`), the bot replies with a secure, single-use deep link.
- Clicking the link opens your prefilled trade page on AstroidBot.
- You review the quote and tap **Confirm** to execute.

### 2. Auto-Execute Mode (Opt-In)
- Enables automatic hands-free trade execution directly when your verified handle tags the bot.
- **Strict Safeguards**: Requires explicitly turning on Auto-Execute in settings, setting a low per-trade USD limit, and establishing a daily rolling cap.

---

## Security Safeguards

- **Immutable User ID Binding**: Trades are authenticated using immutable social platform user IDs, never display handles (preventing handle spoofing).
- **Post Idempotency**: Duplicate posts or retweets cannot trigger repeated trades.
- **Spend Limits**: All social trades enforce strict USD limits independent of account settings.
