import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../types/bot.js";
import { BotStatus } from "../../types.js";
import { TelegramService } from "../../services/telegram.js";
import { DatabaseService } from "../../services/db.js";
import { ConfigManager } from "../../config.js";
import { escapeMd } from "../utils.js";
import { markdownView, renderScreen } from "../ui/render.js";
import { activeChain } from "../chainContext.js";
import { chainLabel } from "../keyboards/builders.js";
import { groupByChainId, walletNativeSymbol } from "../../services/chains/walletChain.js";
import { DEXRegistry } from "../../services/dex/dexRegistry.js";
import { logger } from "../../utils/logger.js";

export async function mainMenu(ctx: BotContext): Promise<void> {
  ctx.session.backScreen = undefined;
  const telegram = TelegramService.getInstance();
  const { status } = telegram.getStatus();
  const pollInterval = ConfigManager.getInstance().config.POLL_INTERVAL_SECONDS;
  const db = DatabaseService.getInstance();

  const statusEmoji = status === BotStatus.RUNNING ? "🟢" : status === BotStatus.HALTED ? "🔴" : "⚪";

  const telegramId = BigInt(ctx.from?.id ?? 0);
  const user = telegramId ? await db.findUserByTelegramId(telegramId) : null;

  const wallets = user ? await db.findWalletsByUserId(user.id) : [];
  const totalBalance = await portfolioUsd(wallets);
  const orders = user ? await db.prisma.limitOrder.count({ where: { userId: user.id, status: "ACTIVE" } }) : 0;
  const strategiesCount = user
    ? await db.prisma.tradingStrategy.count({ where: { userId: user.id, isActive: true } })
    : 0;

  const displayName = ctx.from?.first_name ?? user?.username ?? "trader";
  const chain = await activeChain(ctx);

  const lines = [
    `🤖 *AstroidBot*`,
    "",
    user ? `Welcome, *${escapeMd(displayName)}*!` : "Welcome to AstroidBot!",
    "",
    `Status: ${statusEmoji} *${status}*  ·  cycle: ${pollInterval}s`,
    `Network: ${escapeMd(chainLabel(chain))}`,
    `Portfolio: ${totalBalance === null ? "—" : `$${totalBalance.toFixed(2)}`}${user ? `  ·  ⭐ ${user.points}pts` : ""}`,
    `💼 ${wallets.length} wallet(s)  ·  📋 ${orders} orders  ·  🧠 ${strategiesCount} strategies`,
  ];

  if (user && !user.email) {
    lines.push("", "⚠️ *Email not linked* — tap Email button below");
  }

  const text = lines.join("\n");

  const keyboard = new InlineKeyboard()
    .text(`⛓ ${chain.displayName}`, "action:select_chain")
    .row()
    .text("📊 Portfolio", "screen:portfolio")
    .text("💼 Wallets", "screen:wallets")
    .row()
    .text("📈 Trades", "screen:trades")
    .text("📋 Limit Orders", "screen:orders")
    .row()
    .text("🛒 Quick Trade", "screen:trade")
    .text("🤖 Agents", "screen:agents")
    .row()
    .text("⚙️ Settings", "screen:settings")
    .text(user?.email ? "📧 Email ✓" : "📧 Link Email", user?.email ? "action:noop" : "action:link_email_start");

  if (ConfigManager.getInstance().telegramAdminIds.includes(BigInt(ctx.from?.id ?? 0))) {
    keyboard.row().text("🛡 Admin Control", "screen:control");
  }
  const miniAppUrl = ConfigManager.getInstance().config.TELEGRAM_MINI_APP_URL;
  if (miniAppUrl) keyboard.row().webApp("🚀 Open Astroid App", miniAppUrl);

  await renderScreen(ctx, markdownView(text, keyboard));
}

/**
 * The account's total value in USD, or `null` when it cannot be determined.
 *
 * This was `wallets.reduce((s, w) => s + w.balance, 0)` rendered with a `$`.
 * `balance` is each wallet's *native* balance, so the figure added quantities
 * of different assets on different chains and called the result dollars: 40
 * STX plus 0.5 ETH plus 2 SOL displayed as "$42.50". It was wrong by orders of
 * magnitude and looked entirely plausible.
 *
 * Priced per chain rather than per wallet — the native asset is a property of
 * the chain, so a user with four Base wallets costs one lookup, not four. A
 * chain whose native price cannot be fetched makes the whole total unknown
 * rather than smaller: silently dropping a chain would understate the account,
 * and "—" is at least true.
 */
async function portfolioUsd(
  wallets: { balance: number; chain: string | null; chainFamily: string }[]
): Promise<number | null> {
  if (wallets.length === 0) return 0;

  try {
    const registry = DEXRegistry.getInstance();
    let total = 0;

    for (const [chainId, group] of groupByChainId(wallets)) {
      const native = group.reduce((sum, w) => sum + w.balance, 0);
      if (native === 0) continue;

      const price = await registry.getTokenPrice(walletNativeSymbol(group[0]!), chainId);
      if (price === null || !Number.isFinite(price) || price <= 0) return null;

      total += native * price;
    }

    return total;
  } catch (error) {
    logger.debug("[mainMenu] portfolio total unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
