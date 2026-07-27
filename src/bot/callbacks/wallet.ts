import { InlineKeyboard } from "grammy";
import { DatabaseService } from "../../services/db.js";
import { ChainAdapterRegistry } from "../../services/chains/chainAdapterRegistry.js";
import { encrypt } from "../../utils/crypto.js";
import { logger } from "../../utils/logger.js";
import { chainPicker, chainLabel } from "../keyboards/builders.js";
import { expandChainId } from "./codec.js";
import type { BotContext } from "../../types/bot.js";

/**
 * Chain-aware wallet provisioning for Telegram.
 *
 * The bug this replaces: router.ts called the Stacks-only generateWalletKeypair
 * / deriveAddressFromPrivateKey directly and passed no chainFamily to
 * createWallet, so a Telegram user could only ever get a Stacks wallet — every
 * other chain was unreachable from the bot even when fully enabled. The
 * duplicate check was also unscoped, though the unique key is
 * [chainFamily, address].
 *
 * These mirror UserController.generateWallet/importWallet exactly, so the two
 * interfaces cannot drift.
 */

function escapeMd(s: string): string {
  return s.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");
}

/**
 * Step 1 of both flows: pick a chain.
 *
 * Shown even when only one chain is enabled — it costs one tap and makes the
 * chain explicit at the moment funds are provisioned, which is the moment it
 * matters most. `tradableOnly` is false here on purpose: holding a balance on
 * a chain with no DEX yet is legitimate.
 */
export async function promptChainForWallet(
  ctx: BotContext,
  mode: "create" | "import"
): Promise<unknown> {
  const chains = ChainAdapterRegistry.getInstance().list();

  if (chains.length === 0) {
    return ctx.reply("⚠️ No chains are enabled on this deployment.");
  }

  const verb = mode === "create" ? "create" : "import";
  return ctx.reply(`⛓ *Which chain should this wallet ${verb} on?*`, {
    parse_mode: "Markdown",
    reply_markup: chainPicker("wallet", mode === "create" ? "new" : "imp"),
  });
}

/** Step 2 of create: generate through the chain's adapter. */
export async function createWalletOnChain(
  ctx: BotContext,
  shortChainId: string
): Promise<unknown> {
  const chainId = expandChainId(shortChainId);
  const registry = ChainAdapterRegistry.getInstance();

  if (!registry.has(chainId)) {
    return ctx.reply(`⚠️ Chain \`${escapeMd(chainId)}\` is not enabled.`, {
      parse_mode: "Markdown",
    });
  }

  const adapter = registry.get(chainId);
  const db = DatabaseService.getInstance();
  const user = await db.findUserByTelegramId(BigInt(ctx.from?.id ?? 0));
  if (!user) return ctx.reply("⚠️ Account not found. Send /start first.");

  try {
    const { privateKeyHex, address } = await adapter.generateWalletKeypair();
    const wallets = await db.findWalletsByUserId(user.id);
    const walletName = `Wallet ${wallets.length + 1}`;

    await db.createWallet({
      userId: user.id,
      address,
      name: walletName,
      encryptedKey: encrypt(privateKeyHex),
      chainFamily: adapter.chainFamily,
      chain: adapter.chainId(),
    });

    logger.info("Wallet generated via Telegram", { userId: user.id, chain: adapter.chainId() });

    return ctx.reply(
      `✅ *${escapeMd(walletName)}* created on ${escapeMd(chainLabel(adapter.descriptor))}\n\n` +
      `Address: \`${address}\``,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .url("🔎 Explorer", adapter.descriptor.explorerAddressUrl(address))
          .row()
          .text("👛 Wallets", "wallets_screen"),
      }
    );
  } catch (error) {
    logger.error("Telegram wallet creation failed", {
      chainId,
      error: error instanceof Error ? error.message : String(error),
    });
    return ctx.reply("❌ Could not create the wallet. Please try again.");
  }
}

/** Step 2 of import: remember the chain, then ask for the key. */
export async function promptKeyForChain(
  ctx: BotContext,
  shortChainId: string
): Promise<unknown> {
  const chainId = expandChainId(shortChainId);
  const registry = ChainAdapterRegistry.getInstance();

  if (!registry.has(chainId)) {
    return ctx.reply(`⚠️ Chain \`${escapeMd(chainId)}\` is not enabled.`, {
      parse_mode: "Markdown",
    });
  }

  const adapter = registry.get(chainId);
  ctx.session.importChainId = chainId;
  ctx.session.waitingFor = "import_wallet";

  return ctx.reply(
    `📥 Paste your *${escapeMd(adapter.descriptor.displayName)}* private key:\n\n` +
    `_It is encrypted immediately and never logged._\n\n/cancel to abort.`,
    { parse_mode: "Markdown" }
  );
}

/**
 * Step 3 of import: derive through the chain's adapter and duplicate-check
 * scoped to that chain's family.
 */
export async function importWalletKey(ctx: BotContext, key: string): Promise<unknown> {
  const registry = ChainAdapterRegistry.getInstance();
  // Falls back to Stacks only for a session that began before the chain picker
  // existed; new flows always set it.
  const chainId = ctx.session.importChainId ?? "stacks:mainnet";

  if (!registry.has(chainId)) {
    ctx.session.waitingFor = null;
    return ctx.reply(`⚠️ Chain \`${escapeMd(chainId)}\` is no longer enabled.`, {
      parse_mode: "Markdown",
    });
  }

  const adapter = registry.get(chainId);
  const trimmed = key.trim();

  let address: string;
  try {
    address = await adapter.deriveAddressFromPrivateKey(trimmed);
  } catch {
    return ctx.reply(
      `❌ That is not a valid ${escapeMd(adapter.descriptor.displayName)} private key. ` +
      `Try again or /cancel.`,
      { parse_mode: "Markdown" }
    );
  }

  const db = DatabaseService.getInstance();
  // Scoped by family: the unique key is [chainFamily, address], and the same
  // key material imported on two chains is two legitimately distinct wallets.
  if (await db.findWalletByAddress(address, adapter.chainFamily)) {
    ctx.session.waitingFor = null;
    return ctx.reply("⚠️ That wallet is already imported.");
  }

  ctx.session.tempPrivateKey = encrypt(trimmed);
  ctx.session.tempAddress = address;
  ctx.session.waitingFor = "import_wallet_name";

  return ctx.reply("✍️ *Enter a name for this imported wallet:*", { parse_mode: "Markdown" });
}

/** Step 4 of import: persist with the chain recorded. */
export async function saveImportedWallet(ctx: BotContext, name: string): Promise<unknown> {
  const db = DatabaseService.getInstance();
  const user = await db.findUserByTelegramId(BigInt(ctx.from?.id ?? 0));
  if (!user) return ctx.reply("⚠️ Account not found. Send /start first.");

  const registry = ChainAdapterRegistry.getInstance();
  const chainId = ctx.session.importChainId ?? "stacks:mainnet";
  const adapter = registry.has(chainId) ? registry.get(chainId) : undefined;

  const wallets = await db.findWalletsByUserId(user.id);
  const walletName = name.trim() || `Wallet ${wallets.length + 1}`;

  await db.createWallet({
    userId: user.id,
    address: ctx.session.tempAddress!,
    name: walletName,
    encryptedKey: ctx.session.tempPrivateKey!,
    chainFamily: adapter?.chainFamily,
    chain: adapter?.chainId(),
  });

  ctx.session.waitingFor = null;
  delete ctx.session.importChainId;
  delete ctx.session.tempPrivateKey;
  delete ctx.session.tempAddress;

  const suffix = adapter ? ` on ${escapeMd(chainLabel(adapter.descriptor))}` : "";
  return ctx.reply(`✅ Wallet *${escapeMd(walletName)}* imported${suffix}.`, {
    parse_mode: "Markdown",
  });
}
