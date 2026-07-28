import { InlineKeyboard } from "grammy";
import bcrypt from "bcrypt";
import { logger } from "../utils/logger.js";
import { ConfigManager } from "../config.js";
import { DatabaseService } from "../services/db.js";
import { escapeMd } from "./utils.js";
import { sendEmail, buildOtpEmail } from "../utils/email.js";
import { isAdmin } from "./context.js";
import { tradeScreen } from "./screens/tradeScreen.js";
import { limitCreateScreen } from "./screens/ordersScreen.js";
import { walletsScreen } from "./screens/walletsScreen.js";
import { promptStrategyField } from "./screens/agentsScreen.js";
import { importWalletKey, saveImportedWallet } from "./callbacks/wallet.js";
import { activeChain, activeChainTokens } from "./chainContext.js";
import { handleNLCommand } from "./nl.js";
import type { BotContext } from "../types/bot.js";

/**
 * The `waitingFor` state machine.
 *
 * Every multi-step flow that needs typed input parks a marker in
 * `ctx.session.waitingFor` and resumes here. Extracted from router.ts, where
 * it shared a 1,382-line file with command registration, callback dispatch and
 * the natural-language handler.
 */
export async function handleText(ctx: BotContext): Promise<unknown> {
    const tid = BigInt(ctx.from?.id ?? 0);
    if (!tid) return;
    const wf = ctx.session.waitingFor;
    const text = ctx.message?.text?.trim() ?? "";

    // ── Link email flow ──
    if (wf === "link_email") {
      const email = text;
      if (!email?.includes("@")) return ctx.reply("Invalid email. Try again:");
      const db = DatabaseService.getInstance();
      const existingEmailUser = await db.findUserByEmail(email);
      if (existingEmailUser && existingEmailUser.telegramId && existingEmailUser.telegramId !== tid) {
        return ctx.reply("This email is already linked to another Telegram account.");
      }

      // Generate a 6-digit OTP
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      ctx.session.emailToLink = email;
      ctx.session.emailOtp = otp;
      ctx.session.emailOtpExpiry = Date.now() + 10 * 60 * 1000; // 10 minutes
      ctx.session.waitingFor = "link_email_otp";

      logger.info(`Generated OTP for ${email}`);
      if (ConfigManager.getInstance().config.DRY_RUN) {
        logger.info(`[DRY_RUN] Email OTP code for ${email} is ${otp}`);
      }

      const emailContent = buildOtpEmail(otp);
      const emailSent = await sendEmail(email, emailContent.subject, emailContent.html);

      const kb = new InlineKeyboard().text("Cancel", "action:cancel_session");
      if (emailSent) {
        let responseMsg = `📧 *Verification Required*\n\nWe have sent a 6-digit verification code to your email *${escapeMd(email)}*.\nPlease enter the OTP to verify ownership:`;
        if (ConfigManager.getInstance().config.DRY_RUN) {
          responseMsg += `\n\n*(DRY_RUN active: check container logs for code)*`;
        }
        return ctx.reply(responseMsg, { parse_mode: "Markdown", reply_markup: kb });
      } else {
        ctx.session.waitingFor = null;
        delete ctx.session.emailToLink;
        delete ctx.session.emailOtp;
        delete ctx.session.emailOtpExpiry;
        return ctx.reply("❌ Failed to send verification email. Please make sure the email is correct and try again later.");
      }
    }

    if (wf === "link_email_otp") {
      const enteredOtp = text;
      if (!ctx.session.emailOtp || !ctx.session.emailToLink) {
        ctx.session.waitingFor = null;
        return ctx.reply("Session expired. Please start over by typing /link_email.");
      }

      if (Date.now() > (ctx.session.emailOtpExpiry ?? 0)) {
        ctx.session.waitingFor = null;
        delete ctx.session.emailToLink;
        delete ctx.session.emailOtp;
        delete ctx.session.emailOtpExpiry;
        return ctx.reply("❌ Verification code has expired. Please type /link_email to start over.");
      }

      if (enteredOtp !== ctx.session.emailOtp) {
        const kb = new InlineKeyboard().text("Cancel", "action:cancel_session");
        return ctx.reply("❌ Invalid verification code. Please check your email and try again:", { reply_markup: kb });
      }

      // OTP is valid!
      const email = ctx.session.emailToLink;
      delete ctx.session.emailOtp;
      delete ctx.session.emailOtpExpiry;

      const db = DatabaseService.getInstance();
      const existingEmailUser = await db.findUserByEmail(email);
      const currentUser = await db.findUserByTelegramId(tid);

      if (existingEmailUser) {
        if (!existingEmailUser.telegramId && currentUser) {
          await db.mergeTelegramAndEmailUsers(existingEmailUser.id, currentUser.id, tid);
          await db.markEmailVerified(existingEmailUser.id);
          ctx.session.waitingFor = null;
          delete ctx.session.emailToLink;
          return ctx.reply("✅ Email verified and linked! Your account has been merged with your existing email registration.");
        }
        ctx.session.waitingFor = null;
        delete ctx.session.emailToLink;
        return ctx.reply("This email is already linked to another Telegram account.");
      }

      // Email is new, prompt user for password to complete registration
      ctx.session.waitingFor = "link_email_password";
      const kb = new InlineKeyboard().text("Cancel", "action:cancel_session");
      return ctx.reply("✅ Email verified! Please enter a password for web dashboard login (8+ chars, 1 letter + 1 number):", { reply_markup: kb });
    }

    if (wf === "link_email_password") {
      const pw = text;
      if (pw.length < 8 || !/[a-zA-Z]/.test(pw) || !/[0-9]/.test(pw))
        return ctx.reply("Password: 8+ chars, 1 letter + 1 number. Try again:");
      const bcrypt_rounds = ConfigManager.getInstance().config.BCRYPT_ROUNDS;
      const hash = await bcrypt.hash(pw, bcrypt_rounds);
      const db = DatabaseService.getInstance();
      const user = await db.findUserByTelegramId(tid);
      if (!user) return;
      await db.linkEmailToUser(user.id, ctx.session.emailToLink!, hash);
      await db.markEmailVerified(user.id);
      ctx.session.waitingFor = null;
      delete ctx.session.emailToLink;
      return ctx.reply("✅ Email linked! You can now log in via the web dashboard.");
    }

    // ── Wallet import ──
    if (wf === "import_wallet") {
      return importWalletKey(ctx, text);
    }

    // ── Wallet import name input ──
    if (wf === "import_wallet_name") {
      await saveImportedWallet(ctx, text);
      return walletsScreen(ctx);
    }

    // ── Agent creation name input ──
    if (wf === "agent_name") {
      const name = text.trim();
      if (!name) return ctx.reply("❌ Name cannot be empty. Please enter a valid name:");
      if (name.length > 64) return ctx.reply("❌ Name is too long (max 64 characters). Try again:");
      ctx.session.tempAgentName = name;
      const { promptAgentContext } = await import("./screens/agentsScreen.js");
      await promptAgentContext(ctx, name);
      return;
    }

    // ── Delete wallet ──
    if (wf === "delete_wallet") {
      const walletId = parseInt(text, 10);
      if (isNaN(walletId)) return ctx.reply("Enter a wallet ID number:");
      const db = DatabaseService.getInstance();
      const user = await db.findUserByTelegramId(tid);
      const wallet = await db.findWalletById(walletId);
      if (!wallet || wallet.userId !== user!.id) return ctx.reply("Wallet not found.");
      await db.prisma.wallet.delete({ where: { id: walletId } });
      ctx.session.waitingFor = null;
      return ctx.reply("✅ Wallet deleted.");
    }

    // ── Trade amount ──
    if (wf === "trade_amount") {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) return ctx.reply("Enter a valid positive number:");
      ctx.session.waitingFor = null;
      ctx.session.tradeAmount = amount;
      return tradeScreen(ctx, "confirm");
    }

    if (wf === "trade_token_in") {
      const symbol = text.toUpperCase();
      // Scoped to the active chain: unscoped, a Base token validates fine for a
      // Stacks wallet and then fails at quote time with an opaque "no route".
      const tokens = await activeChainTokens(ctx);
      const chain = await activeChain(ctx);
      const found = tokens.some((t) => t.symbol.toUpperCase() === symbol);
      const isChainAsset =
        symbol === chain.nativeSymbol.toUpperCase() || symbol === chain.stableSymbol.toUpperCase();
      if (!found && !isChainAsset) {
        return ctx.reply(`❌ Token *${escapeMd(symbol)}* is not recognized by any DEX provider. Please try another symbol:`, { parse_mode: "Markdown" });
      }
      ctx.session.tradeTokenIn = symbol;
      ctx.session.waitingFor = null;
      return tradeScreen(ctx, "pick_token_out");
    }

    if (wf === "trade_token_out") {
      const symbol = text.toUpperCase();
      const tokens = await activeChainTokens(ctx);
      const chain = await activeChain(ctx);
      const found = tokens.some((t) => t.symbol.toUpperCase() === symbol);
      const isChainAsset =
        symbol === chain.nativeSymbol.toUpperCase() || symbol === chain.stableSymbol.toUpperCase();
      if (!found && !isChainAsset) {
        return ctx.reply(`❌ Token *${escapeMd(symbol)}* is not recognized by any DEX provider. Please try another symbol:`, { parse_mode: "Markdown" });
      }
      if (symbol === ctx.session.tradeTokenIn) {
        return ctx.reply("❌ Destination token cannot be the same as the source token. Try again:");
      }
      ctx.session.tradeTokenOut = symbol;
      ctx.session.waitingFor = null;
      return tradeScreen(ctx, "enter_amount");
    }

    if (wf === "trade_amount_custom") {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) return ctx.reply("❌ Enter a valid positive number:");
      ctx.session.waitingFor = null;
      ctx.session.tradeAmount = amount;
      return tradeScreen(ctx, "confirm");
    }

    if (wf && wf.startsWith("strat_field:")) {
      const fieldName = wf.split(":")[1];
      if (fieldName) {
        const num = parseFloat(text);
        const parsedValue = isNaN(num) ? text : num;
        ctx.session.tempStrategyConfig = {
          ...(ctx.session.tempStrategyConfig ?? {}),
          [fieldName]: parsedValue,
        };
        ctx.session.tempStrategyFieldIndex = (ctx.session.tempStrategyFieldIndex ?? 0) + 1;
        ctx.session.waitingFor = null;
        return promptStrategyField(ctx);
      }
    }

    // ── Limit order amount ──
    if (wf === "limit_amount") {
      const amount = parseFloat(text);
      if (isNaN(amount) || amount <= 0) return ctx.reply("Enter a valid positive number:");
      ctx.session.waitingFor = null;
      ctx.session.limitAmount = amount;
      return limitCreateScreen(ctx, "enter_price");
    }

    // ── Limit order price ──
    if (wf === "limit_price") {
      const price = parseFloat(text);
      if (isNaN(price) || price <= 0) return ctx.reply("Enter a valid price:");
      ctx.session.waitingFor = null;
      ctx.session.limitPrice = price;
      return limitCreateScreen(ctx, "confirm");
    }

    // ── Broadcast ──
    if (wf === "broadcast_msg") {
      if (!isAdmin(ctx)) return;
      ctx.session.waitingFor = null;
      const users = await DatabaseService.getInstance().getUsersWithTelegram();
      let sent = 0;
      for (const u of users) {
        try { await ctx.api.sendMessage(Number(u.telegramId), `📢 ${text}`); sent++; } catch { }
      }
      return ctx.reply(`📢 Sent to ${sent}/${users.length} users.`);
    }

    // ── Natural Language fallback ──
    if (!text || text.startsWith("/")) return;
    await handleNLCommand(ctx, text);
}
