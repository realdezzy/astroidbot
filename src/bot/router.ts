import { Bot, InlineKeyboard } from "grammy";
import { logger } from "../utils/logger.js";
import { ConfigManager } from "../config.js";
import { DatabaseService } from "../services/db.js";
import { TelegramService } from "../services/telegram.js";
import { LimitOrderService } from "../services/limitOrder.js";
import { BotStatus } from "../types.js";
import { adminGuard } from "./middleware/adminGuard.js";
import { rateLimiter } from "./middleware/rateLimiter.js";
import { mainMenu } from "./screens/mainMenu.js";
import { portfolioScreen } from "./screens/portfolioScreen.js";
import { walletsScreen } from "./screens/walletsScreen.js";
import { ordersScreen, limitCreateScreen } from "./screens/ordersScreen.js";
import { settingsScreen } from "./screens/settingsScreen.js";
import { controlScreen } from "./screens/controlScreen.js";
import { tradeScreen } from "./screens/tradeScreen.js";
import { tradesScreen } from "./screens/tradesScreen.js";
import { agentsScreen, runAgent, toggleAgent, setAgentAiMode, deleteAgent, startStrategyWizard, promptStrategyWallets, promptStrategyField } from "./screens/agentsScreen.js";
import { agentDetailsScreen, agentAiModeMenuScreen, agentStrategiesMenuScreen } from "./screens/agentDetailsScreen.js";
import { DEXRegistry } from "../services/dex/dexRegistry.js";
import { generateWalletKeypair, deriveAddressFromPrivateKey } from "../services/wallet.js";
import { encrypt } from "../utils/crypto.js";
import { escapeMd } from "./utils.js";
import { sendEmail, buildOtpEmail } from "../utils/email.js";
import type { BotContext } from "./types.js";
import bcrypt from "bcrypt";
import axios from "axios";
import { spawn } from "child_process";
import OpenAI, { toFile } from "openai";

export { type BotContext } from "./types.js";


function isAdmin(ctx: BotContext): boolean {
  const adminIds = ConfigManager.getInstance().telegramAdminIds;
  return adminIds.includes(BigInt(ctx.from?.id ?? 0));
}

const screenMap: Record<string, (ctx: BotContext) => Promise<void>> = {
  main: mainMenu,
  portfolio: portfolioScreen,
  wallets: walletsScreen,
  orders: ordersScreen,
  settings: settingsScreen,
  control: controlScreen,
  trade: tradeScreen,
  trades: tradesScreen,
  agents: agentsScreen,
};

export function registerRouter(bot: Bot<BotContext>): void {

  // ════════════════════ Commands ════════════════════

  bot.command("start", rateLimiter, async (ctx) => {
    const telegramId = BigInt(ctx.from?.id ?? 0);
    if (!telegramId) return;
    const db = DatabaseService.getInstance();
    let user = await db.findUserByTelegramId(telegramId);
    if (!user) {
      user = await db.createUser({ telegramId, username: ctx.from?.username });
      logger.info("New user registered", { telegramId: telegramId.toString() });
      try { await (await import("../services/wallet.js")).provisionDefaultWallet(user.id); } catch { }
      if (ConfigManager.getInstance().config.DRY_RUN) {
        try { await db.markEmailVerified(user.id); } catch { }
      }
    }
    await mainMenu(ctx);
  });

  bot.command("help", rateLimiter, async (ctx) => {
    let text = [
      "🆘 *Commands*",
      "",
      "/start — Main menu",
      "/trade — Quick token swap",
      "/portfolio — View holdings",
      "/wallets — Manage wallets",
      "/trades — Recent trade history",
      "/orders — Limit orders",
      "/agents — AI trading agents",
      "/settings — Risk/slippage config",
      "/link\\_email — Connect email",
      "/ai — AI assistant",
      "/help — This list",
      "/cancel — Abort any flow",
    ].join("\n");
    if (isAdmin(ctx)) {
      text += [
        "", "",
        "🔐 *Admin*",
        "/halt /resume /stats /users /user /disable /enable /points /broadcast",
      ].join("\n");
    }
    await ctx.reply(text, { parse_mode: "Markdown" });
  });

  bot.command("halt", adminGuard, rateLimiter, async (ctx) => {
    TelegramService.getInstance().setStatus(BotStatus.HALTED, "Admin halt via /halt");
    await ctx.reply("🛑 Trading halted.");
  });

  bot.command("resume", adminGuard, rateLimiter, async (ctx) => {
    TelegramService.getInstance().setStatus(BotStatus.RUNNING);
    await ctx.reply("✅ Trading resumed.");
  });

  bot.command("stats", adminGuard, rateLimiter, async (ctx) => {
    const s = await DatabaseService.getInstance().getStats();
    await ctx.reply(
      `📊 *System Stats*\n\nUsers: ${s.totalUsers}\nWallets: ${s.totalWallets}\nTrades: ${s.totalTrades}\nUptime: ${Math.floor(process.uptime() / 60)}m`,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("users", adminGuard, rateLimiter, async (ctx) => {
    const users = await DatabaseService.getInstance().getAllUsers(1, 10);
    if (users.length === 0) return ctx.reply("No users.");
    await ctx.reply(
      users.map(u => `${u.id}. ${u.isActive ? "✅" : "❌"} ${u.username ?? u.email ?? "N/A"} | ${u.points}pts`).join("\n"),
      { parse_mode: "Markdown" }
    );
  });

  bot.command("user", adminGuard, rateLimiter, async (ctx) => {
    const uid = parseInt(ctx.match?.trim() ?? "", 10);
    if (isNaN(uid)) return ctx.reply("Usage: /user <id>");
    const u = await DatabaseService.getInstance().findUserById(uid);
    if (!u) return ctx.reply("Not found.");
    await ctx.reply(`👤 #${u.id} | ${u.username ?? "N/A"} | Email: ${u.email ?? "N/A"} | Points: ${u.points} | Active: ${u.isActive ? "✅" : "❌"}`);
  });

  bot.command("disable", adminGuard, rateLimiter, async (ctx) => {
    const uid = parseInt(ctx.match?.trim() ?? "", 10);
    if (isNaN(uid)) return ctx.reply("Usage: /disable <id>");
    await DatabaseService.getInstance().setUserActive(uid, false);
    await ctx.reply(`❌ User #${uid} disabled.`);
  });

  bot.command("enable", adminGuard, rateLimiter, async (ctx) => {
    const uid = parseInt(ctx.match?.trim() ?? "", 10);
    if (isNaN(uid)) return ctx.reply("Usage: /enable <id>");
    await DatabaseService.getInstance().setUserActive(uid, true);
    await ctx.reply(`✅ User #${uid} enabled.`);
  });

  bot.command("points", adminGuard, rateLimiter, async (ctx) => {
    const parts = ctx.match?.trim().split(/\s+/);
    if (!parts || parts.length < 2) return ctx.reply("Usage: /points <id> <amount>");
    await DatabaseService.getInstance().addPoints(parseInt(parts[0]!, 10), parseInt(parts[1]!, 10));
    await ctx.reply("⭐ Done.");
  });

  bot.command("broadcast", adminGuard, rateLimiter, async (ctx) => {
    const msg = ctx.match?.trim();
    if (!msg) return ctx.reply("Usage: /broadcast <message>");
    const users = await DatabaseService.getInstance().getUsersWithTelegram();
    let sent = 0;
    for (const u of users) {
      try { await ctx.api.sendMessage(Number(u.telegramId), `📢 ${msg}`); sent++; } catch { }
    }
    await ctx.reply(`📢 Sent to ${sent}/${users.length}.`);
  });

  bot.command("link_email", rateLimiter, async (ctx) => {
    const tid = BigInt(ctx.from?.id ?? 0);
    if (!tid) return;
    const user = await DatabaseService.getInstance().findUserByTelegramId(tid);
    if (!user) return ctx.reply("Please /start first.");
    if (user.email) return ctx.reply(`Your account is linked to: *${escapeMd(user.email)}*`, { parse_mode: "Markdown" });
    const keyboard = new InlineKeyboard()
      .text("📧 Enter Email", "action:link_email_start")
      .text("🏠 Home", "home");
    await ctx.reply("📧 *Link Email*\n\nYour Telegram account isn't linked to an email yet.\nClick below to connect one:", {
      parse_mode: "Markdown", reply_markup: keyboard,
    });
  });

  bot.command("cancel", rateLimiter, async (ctx) => {
    ctx.session.waitingFor = null;
    delete ctx.session.emailToLink;
    delete ctx.session.emailOtp;
    delete ctx.session.emailOtpExpiry;
    delete ctx.session.tradePair;
    delete ctx.session.tradeDir;
    delete ctx.session.tradeAmount;
    delete ctx.session.limitPair;
    delete ctx.session.limitDir;
    delete ctx.session.limitAmount;
    delete ctx.session.limitPrice;
    delete ctx.session.tempPrivateKey;
    delete ctx.session.tempAddress;
    await ctx.reply("❌ Cancelled. Type /start for main menu.");
  });

  bot.command("trade", rateLimiter, async (ctx) => { await tradeScreen(ctx, "pick_pair"); });
  bot.command("portfolio", rateLimiter, async (ctx) => { await portfolioScreen(ctx); });
  bot.command("wallets", rateLimiter, async (ctx) => { await walletsScreen(ctx); });
  bot.command("trades", rateLimiter, async (ctx) => { await tradesScreen(ctx); });
  bot.command("orders", rateLimiter, async (ctx) => { await ordersScreen(ctx); });
  bot.command("agents", rateLimiter, async (ctx) => { await agentsScreen(ctx); });
  bot.command("settings", rateLimiter, async (ctx) => { await settingsScreen(ctx); });
  bot.command("ai", rateLimiter, async (ctx) => {
    await agentsScreen(ctx);
  });

  // ════════════════════ Hears Patterns ════════════════════

  bot.hears(/^\/link[_-]?email$/i, rateLimiter, async (ctx) => {
    const tid = BigInt(ctx.from?.id ?? 0);
    if (!tid) return;
    const user = await DatabaseService.getInstance().findUserByTelegramId(tid);
    if (!user) return ctx.reply("Please /start first.");
    if (user.email) return ctx.reply(`Your account is linked to: *${escapeMd(user.email)}*`, { parse_mode: "Markdown" });
    ctx.session.waitingFor = "link_email";
    await ctx.reply("📧 Enter your email address:");
  });

  bot.hears(/^\/cancel_(\d+)$/, rateLimiter, async (ctx) => {
    const orderId = ctx.match?.[1];
    if (orderId) await ordersScreen(ctx, orderId);
  });

  bot.hears(/^\/reveal_(\d+)$/, rateLimiter, async (ctx) => {
    return ctx.reply(
      "❌ *Security Protection*\n\nFor your security, private keys cannot be revealed or displayed within Telegram chats. Please log in to the secure Web Dashboard and navigate to the `/wallets` page to view your keys.",
      { parse_mode: "Markdown" }
    );
  });

  // Agent shortcuts: /run_1, /toggle_2, /del_3, /aimode_1_advisor
  bot.hears(/^\/run_(\d+)$/, rateLimiter, async (ctx) => {
    const agentId = parseInt(ctx.match?.[1] ?? "", 10);
    if (isNaN(agentId)) return;
    await runAgent(ctx, agentId);
  });

  bot.hears(/^\/toggle_(\d+)$/, rateLimiter, async (ctx) => {
    const agentId = parseInt(ctx.match?.[1] ?? "", 10);
    if (isNaN(agentId)) return;
    await toggleAgent(ctx, agentId);
  });

  bot.hears(/^\/del_(\d+)$/, rateLimiter, async (ctx) => {
    const agentId = parseInt(ctx.match?.[1] ?? "", 10);
    if (isNaN(agentId)) return;
    await deleteAgent(ctx, agentId);
  });

  bot.hears(/^\/aimode_(\d+)_(\w+)$/, rateLimiter, async (ctx) => {
    const agentId = parseInt(ctx.match?.[1] ?? "", 10);
    const mode = ctx.match?.[2] ?? "";
    if (isNaN(agentId) || !["off", "advisor", "autonomous"].includes(mode)) return;
    await setAgentAiMode(ctx, agentId, mode);
  });

  // ════════════════════ Text Message Input Sessions ════════════════════

  bot.on("message:text", rateLimiter, async (ctx) => {
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
      let address: string;
      try { address = deriveAddressFromPrivateKey(text); } catch { return ctx.reply("Invalid Stacks private key. Try again or /cancel."); }
      const db = DatabaseService.getInstance();
      if (await db.findWalletByAddress(address)) return ctx.reply("Wallet already exists.");
      ctx.session.tempPrivateKey = encrypt(text);
      ctx.session.tempAddress = address;
      ctx.session.waitingFor = "import_wallet_name";
      return ctx.reply("✍️ *Enter a name for this imported wallet:*", { parse_mode: "Markdown" });
    }

    // ── Wallet import name input ──
    if (wf === "import_wallet_name") {
      const db = DatabaseService.getInstance();
      const user = await db.findUserByTelegramId(tid);
      if (!user) return;
      const wallets = await db.findWalletsByUserId(user.id);
      const walletName = text.trim() || `Wallet ${wallets.length + 1}`;
      const tempAddress = ctx.session.tempAddress!;
      await db.createWallet({
        userId: user.id,
        address: tempAddress,
        name: walletName,
        encryptedKey: ctx.session.tempPrivateKey!,
      });
      ctx.session.waitingFor = null;
      delete ctx.session.tempPrivateKey;
      delete ctx.session.tempAddress;
      await ctx.reply(`✅ Wallet *${escapeMd(walletName)}* imported!\n\nAddress: \`${tempAddress}\``, { parse_mode: "Markdown" });
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
      const tokens = await DEXRegistry.getInstance().getSwappableTokens();
      const found = tokens.some((t) => t.symbol.toUpperCase() === symbol);
      if (!found && symbol !== "STX" && symbol !== "SUSDT") {
        return ctx.reply(`❌ Token *${escapeMd(symbol)}* is not recognized by any DEX provider. Please try another symbol:`, { parse_mode: "Markdown" });
      }
      ctx.session.tradeTokenIn = symbol;
      ctx.session.waitingFor = null;
      return tradeScreen(ctx, "pick_token_out");
    }

    if (wf === "trade_token_out") {
      const symbol = text.toUpperCase();
      const tokens = await DEXRegistry.getInstance().getSwappableTokens();
      const found = tokens.some((t) => t.symbol.toUpperCase() === symbol);
      if (!found && symbol !== "STX" && symbol !== "SUSDT") {
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
  });

  // ════════════════════ Voice Messages ════════════════════

  bot.on(":voice", rateLimiter, async (ctx) => {
    const tid = BigInt(ctx.from?.id ?? 0);
    if (!tid) return;
    const user = await DatabaseService.getInstance().findUserByTelegramId(tid);
    if (!user) return;

    try {
      const waitMsg = await ctx.reply("🎤 Transcribing voice message...");

      const file = await ctx.getFile();
      if (!file.file_path) {
        throw new Error("No file path returned from Telegram.");
      }

      const botToken = ConfigManager.getInstance().config.TELEGRAM_BOT_TOKEN;
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;

      const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
      const buffer = Buffer.from(response.data);

      // Transcode ogg/opus to mp3 using ffmpeg
      const mp3Buffer = await new Promise<Buffer>((resolve, reject) => {
        const ffmpeg = spawn("ffmpeg", ["-i", "pipe:0", "-f", "mp3", "pipe:1"]);
        const chunks: Buffer[] = [];
        ffmpeg.stdout.on("data", (chunk) => chunks.push(chunk));
        ffmpeg.on("close", (code) => {
          if (code === 0) resolve(Buffer.concat(chunks));
          else reject(new Error(`ffmpeg process exited with code ${code}`));
        });
        ffmpeg.stdin.on("error", (err) => reject(err));
        ffmpeg.stdout.on("error", (err) => reject(err));
        ffmpeg.stdin.write(buffer);
        ffmpeg.stdin.end();
      });

      const openaiApiKey = ConfigManager.getInstance().config.OPENAI_API_KEY;
      if (!openaiApiKey || openaiApiKey.startsWith("sk-...")) {
        throw new Error("OpenAI API key is not configured.");
      }

      const openai = new OpenAI({ apiKey: openaiApiKey });
      const fileObj = await toFile(mp3Buffer, "voice.mp3", { type: "audio/mp3" });

      const transcription = await openai.audio.transcriptions.create({
        file: fileObj,
        model: "whisper-1",
      });

      const transcriptionText = transcription.text.trim();
      if (!transcriptionText) {
        try { await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch { }
        return ctx.reply("🔇 Could not hear or understand the audio. Please speak clearly.");
      }

      try { await ctx.api.deleteMessage(ctx.chat.id, waitMsg.message_id); } catch { }
      await ctx.reply(`🎤 *You said:* "${transcriptionText}"`, { parse_mode: "Markdown" });

      await handleNLCommand(ctx, transcriptionText);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Voice transcription failed", { error: msg });
      await ctx.reply("❌ Voice transcription failed. Please type your command instead, e.g. 'buy 5 STX for sUSDT' or 'show portfolio'.");
    }
  });

  // ════════════════════ Callback Queries ════════════════════

  bot.on("callback_query:data", rateLimiter, async (ctx) => {
    const data = ctx.callbackQuery?.data;
    if (!data) return;

    if (data === "action:noop") {
      await ctx.answerCallbackQuery();
      return;
    }

    await ctx.answerCallbackQuery();

    // ── Navigation ──
    if (data === "home") return mainMenu(ctx);

    if (data === "screen:control" && !isAdmin(ctx)) {
      await ctx.answerCallbackQuery({ text: "🔒 Admin only", show_alert: true });
      return;
    }

    for (const [prefix, handler] of Object.entries(screenMap)) {
      if (data === `screen:${prefix}`) return handler(ctx);
    }

    // ── Back button ──
    if (data === "screen:back") {
      const back = ctx.session.backScreen ?? "main";
      ctx.session.backScreen = undefined;
      const handler = screenMap[back] ?? mainMenu;
      return handler(ctx);
    }

    if (!data.startsWith("action:")) return mainMenu(ctx);

    const action = data.slice(7);

    // Agent details and aimode
    if (action.startsWith("agent_details:")) {
      const id = parseInt(action.slice(14), 10);
      const { agentDetailsScreen } = await import("./screens/agentDetailsScreen.js");
      return agentDetailsScreen(ctx, id);
    }
    if (action.startsWith("agent_toggle_details:")) {
      const id = parseInt(action.slice(21), 10);
      await toggleAgent(ctx, id);
      const { agentDetailsScreen } = await import("./screens/agentDetailsScreen.js");
      return agentDetailsScreen(ctx, id);
    }
    if (action.startsWith("agent_run_details:")) {
      const id = parseInt(action.slice(18), 10);
      await runAgent(ctx, id);
      const { agentDetailsScreen } = await import("./screens/agentDetailsScreen.js");
      return agentDetailsScreen(ctx, id);
    }
    if (action.startsWith("agent_delete_details:")) {
      const id = parseInt(action.slice(21), 10);
      await deleteAgent(ctx, id);
      return agentsScreen(ctx);
    }
    if (action.startsWith("agent_aimode_menu:")) {
      const id = parseInt(action.slice(18), 10);
      const { agentAiModeMenuScreen } = await import("./screens/agentDetailsScreen.js");
      return agentAiModeMenuScreen(ctx, id);
    }
    if (action.startsWith("agent_aimode_set:")) {
      const parts = action.split(":");
      const id = parseInt(parts[2] ?? "", 10);
      const mode = parts[3] ?? "off";
      await setAgentAiMode(ctx, id, mode);
      const { agentDetailsScreen } = await import("./screens/agentDetailsScreen.js");
      return agentDetailsScreen(ctx, id);
    }
    if (action.startsWith("agent_strategies_menu:")) {
      const id = parseInt(action.slice(22), 10);
      const { agentStrategiesMenuScreen } = await import("./screens/agentDetailsScreen.js");
      return agentStrategiesMenuScreen(ctx, id);
    }

    // Strategy Wizard Actions
    if (action.startsWith("strat_add:")) {
      const id = parseInt(action.slice(10), 10);
      return startStrategyWizard(ctx, id);
    }
    if (action.startsWith("strat_type:")) {
      const type = action.slice(11);
      ctx.session.tempStrategyType = type;
      return promptStrategyWallets(ctx);
    }
    if (action.startsWith("strat_wallet_toggle:")) {
      const wid = parseInt(action.slice(20), 10);
      const current = ctx.session.tempStrategyWalletIds ?? [];
      if (current.includes(wid)) {
        ctx.session.tempStrategyWalletIds = current.filter((id) => id !== wid);
      } else {
        ctx.session.tempStrategyWalletIds = [...current, wid];
      }
      return promptStrategyWallets(ctx);
    }
    if (action === "strat_wallet_confirm") {
      const current = ctx.session.tempStrategyWalletIds ?? [];
      if (current.length === 0) {
        await ctx.answerCallbackQuery({ text: "Please select at least one wallet.", show_alert: true });
        return;
      }
      ctx.session.tempStrategyFieldIndex = 0;
      return promptStrategyField(ctx);
    }
    if (action === "strat_confirm_create") {
      const tid = BigInt(ctx.from?.id ?? 0);
      const db = DatabaseService.getInstance();
      const user = await db.findUserByTelegramId(tid);
      if (user && ctx.session.activeAgentId && ctx.session.tempStrategyType) {
        await db.prisma.tradingStrategy.create({
          data: {
            userId: user.id,
            agentId: ctx.session.activeAgentId,
            type: ctx.session.tempStrategyType,
            config: {
              ...ctx.session.tempStrategyConfig,
              walletIds: ctx.session.tempStrategyWalletIds,
            },
            isActive: true,
          },
        });
        await ctx.reply("✅ Strategy created successfully!");
      }
      const aid = ctx.session.activeAgentId!;
      ctx.session.waitingFor = null;
      delete ctx.session.tempStrategyType;
      delete ctx.session.tempStrategyConfig;
      delete ctx.session.tempStrategyWalletIds;
      delete ctx.session.tempStrategyFields;
      delete ctx.session.tempStrategyFieldIndex;
      const { agentDetailsScreen } = await import("./screens/agentDetailsScreen.js");
      return agentDetailsScreen(ctx, aid);
    }
    if (action.startsWith("strat_toggle:")) {
      const sid = parseInt(action.slice(13), 10);
      const db = DatabaseService.getInstance();
      const s = await db.prisma.tradingStrategy.findUnique({ where: { id: sid } });
      if (s) {
        await db.prisma.tradingStrategy.update({ where: { id: sid }, data: { isActive: !s.isActive } });
        await ctx.reply(`Strategy #${sid} ${s.isActive ? "paused" : "activated"}.`);
        if (ctx.session.activeAgentId) {
          const { agentStrategiesMenuScreen } = await import("./screens/agentDetailsScreen.js");
          return agentStrategiesMenuScreen(ctx, ctx.session.activeAgentId);
        }
      }
      return agentsScreen(ctx);
    }
    if (action.startsWith("strat_delete:")) {
      const sid = parseInt(action.slice(13), 10);
      const db = DatabaseService.getInstance();
      await db.prisma.tradingStrategy.delete({ where: { id: sid } });
      await ctx.reply(`Strategy #${sid} deleted.`);
      if (ctx.session.activeAgentId) {
        const { agentStrategiesMenuScreen } = await import("./screens/agentDetailsScreen.js");
        return agentStrategiesMenuScreen(ctx, ctx.session.activeAgentId);
      }
      return agentsScreen(ctx);
    }

    // Trade Wizard Actions
    if (action.startsWith("trade_wallet_select:")) {
      const wid = parseInt(action.slice(20), 10);
      ctx.session.tradeWalletId = wid;
      return tradeScreen(ctx, "pick_token_in");
    }
    if (action.startsWith("trade_token_in_select:")) {
      const symbol = action.slice(22);
      ctx.session.tradeTokenIn = symbol;
      return tradeScreen(ctx, "pick_token_out");
    }
    if (action === "trade_token_in_custom") {
      ctx.session.waitingFor = "trade_token_in";
      await ctx.reply("🔍 Type the Token In symbol (e.g. ALEX):");
      return;
    }
    if (action.startsWith("trade_token_out_select:")) {
      const symbol = action.slice(23);
      ctx.session.tradeTokenOut = symbol;
      return tradeScreen(ctx, "enter_amount");
    }
    if (action === "trade_token_out_custom") {
      ctx.session.waitingFor = "trade_token_out";
      await ctx.reply("🔍 Type the Token Out symbol (e.g. WELSH):");
      return;
    }
    if (action === "trade_restart") {
      delete ctx.session.tradeTokenIn;
      delete ctx.session.tradeTokenOut;
      delete ctx.session.tradeAmount;
      delete ctx.session.tradeWalletId;
      return tradeScreen(ctx, "pick_wallet");
    }
    if (action === "trade_confirm_elite") {
      const tid = BigInt(ctx.from?.id ?? 0);
      const db = DatabaseService.getInstance();
      const user = await db.findUserByTelegramId(tid);
      if (!user) return;
      const walletId = ctx.session.tradeWalletId;
      if (!walletId) return;
      const wallet = await db.findWalletById(walletId);
      if (!wallet || wallet.userId !== user.id) return;
      const tokenIn = ctx.session.tradeTokenIn ?? "STX";
      const tokenOut = ctx.session.tradeTokenOut ?? "sUSDT";
      const rawAmount = ctx.session.tradeAmount;
      const amount = typeof rawAmount === "number" ? rawAmount : parseFloat(String(rawAmount ?? "0"));
      if (amount <= 0) return;

      const qm = (await import("../services/queue.js")).QueueManager.getInstance();
      await qm.enqueueTrade({
        walletId: wallet.id,
        userId: user.id,
        senderAddress: wallet.address,
        tokenIn,
        tokenOut,
        amountIn: amount,
        direction: "BUY",
        reason: `Telegram Swap: ${tokenIn} → ${tokenOut}`,
      });

      delete ctx.session.tradeTokenIn;
      delete ctx.session.tradeTokenOut;
      delete ctx.session.tradeAmount;
      delete ctx.session.tradeWalletId;

      await ctx.reply(`✅ Swap enqueued: spend ${amount} ${tokenIn} to receive ${tokenOut}!`);
      return mainMenu(ctx);
    }

    // ── Refresh ──
    if (action === "refresh_portfolio") return portfolioScreen(ctx);
    if (action === "refresh_wallets") return walletsScreen(ctx);
    if (action === "refresh_orders") return ordersScreen(ctx);
    if (action === "refresh_control") return controlScreen(ctx);
    if (action === "refresh_trades") return tradesScreen(ctx);
    if (action === "refresh_agents") return agentsScreen(ctx);

    // ── Agent wizard actions ──
    if (action === "agent_create") {
      const { createAgentWizardStart } = await import("./screens/agentsScreen.js");
      return createAgentWizardStart(ctx);
    }
    if (action === "cancel_agent_create") {
      ctx.session.waitingFor = null;
      delete ctx.session.tempAgentName;
      delete ctx.session.tempAgentContext;
      await ctx.reply("❌ Agent creation cancelled.");
      const { agentsScreen } = await import("./screens/agentsScreen.js");
      return agentsScreen(ctx);
    }
    if (action.startsWith("agent_ctx:")) {
      const context = action.slice(10);
      ctx.session.tempAgentContext = context;
      const { promptAgentAiMode } = await import("./screens/agentsScreen.js");
      await promptAgentAiMode(ctx, ctx.session.tempAgentName || "Unnamed Agent", context);
      return;
    }
    if (action.startsWith("agent_ai:")) {
      const aiMode = action.slice(9);
      const db = DatabaseService.getInstance();
      const tid = BigInt(ctx.from?.id ?? 0);
      const user = await db.findUserByTelegramId(tid);
      if (!user) return;

      const name = ctx.session.tempAgentName || "Unnamed Agent";
      const context = ctx.session.tempAgentContext || "custom";

      await db.prisma.tradeAgent.create({
        data: {
          userId: user.id,
          name,
          context,
          aiMode,
          config: {},
          model: "deepseek-v4-pro",
        },
      });

      ctx.session.waitingFor = null;
      delete ctx.session.tempAgentName;
      delete ctx.session.tempAgentContext;

      await ctx.reply(`✅ AI Agent *${escapeMd(name)}* created successfully!`, { parse_mode: "Markdown" });
      const { agentsScreen } = await import("./screens/agentsScreen.js");
      return agentsScreen(ctx);
    }

    // ── Agent actions (inline buttons) ──
    if (action.startsWith("agent_run:")) {
      const id = parseInt(action.slice(10), 10);
      if (!isNaN(id)) return runAgent(ctx, id);
      return mainMenu(ctx);
    }
    if (action.startsWith("agent_toggle:")) {
      const id = parseInt(action.slice(13), 10);
      if (!isNaN(id)) return toggleAgent(ctx, id);
      return mainMenu(ctx);
    }
    if (action.startsWith("agent_delete:")) {
      const id = parseInt(action.slice(13), 10);
      if (!isNaN(id)) return deleteAgent(ctx, id);
      return mainMenu(ctx);
    }

    // ── Reveal wallet (inline button with id) ──
    if (action.startsWith("reveal_wallet:")) {
      const wid = parseInt(action.slice(14), 10);
      if (isNaN(wid)) return;
      if (ctx.chat?.type !== "private") {
        await ctx.answerCallbackQuery({ text: "❌ Reveal only works in private chat", show_alert: true });
        return;
      }
      const tid = BigInt(ctx.from?.id ?? 0);
      const db = DatabaseService.getInstance();
      const user = await db.findUserByTelegramId(tid);
      if (!user) return;
      const wallet = await db.findWalletById(wid);
      if (!wallet || wallet.userId !== user.id) {
        await ctx.answerCallbackQuery({ text: "Wallet not found.", show_alert: true });
        return;
      }
      if (user.passwordHash) {
        ctx.session.waitingFor = `reveal_password:${wid}`;
        await ctx.reply("🔒 Enter your password to confirm:");
      } else {
        ctx.session.waitingFor = `reveal_confirm:${wid}`;
        await ctx.reply("⚠️ *Warning:* type `CONFIRM` to reveal your private key:", { parse_mode: "Markdown" });
      }
      return;
    }

    // ── Link email ──
    if (action === "link_email_start") {
      ctx.session.waitingFor = "link_email";
      await ctx.reply("📧 Enter your email address:");
      return;
    }
    if (action === "cancel_session") {
      ctx.session.waitingFor = null;
      delete ctx.session.emailToLink;
      delete ctx.session.emailOtp;
      delete ctx.session.emailOtpExpiry;
      delete ctx.session.tradePair;
      delete ctx.session.tradeDir;
      delete ctx.session.tradeAmount;
      delete ctx.session.limitPair;
      delete ctx.session.limitDir;
      delete ctx.session.limitAmount;
      delete ctx.session.limitPrice;
      delete ctx.session.tempPrivateKey;
      delete ctx.session.tempAddress;
      return mainMenu(ctx);
    }

    // ── Settings toggle ──
    if (action.startsWith("toggle_settings:")) {
      return settingsScreen(ctx, action.replace("toggle_settings:", ""));
    }

    // ── Cancel order ──
    if (action.startsWith("cancel_order:")) {
      return ordersScreen(ctx, action.slice(13));
    }

    // ── Admin halt/resume ──
    if (action === "confirm_halt") {
      if (!isAdmin(ctx)) { await ctx.answerCallbackQuery({ text: "🔒 Admin only", show_alert: true }); return; }
      TelegramService.getInstance().setStatus(BotStatus.HALTED, "Admin halted");
      return controlScreen(ctx);
    }
    if (action === "confirm_resume" || data === "resume_cmd") {
      if (!isAdmin(ctx)) { await ctx.answerCallbackQuery({ text: "🔒 Admin only", show_alert: true }); return; }
      TelegramService.getInstance().setStatus(BotStatus.RUNNING);
      return controlScreen(ctx);
    }

    // ── Wallet create / import / delete / reveal ──
    if (action === "create_wallet") {
      const tid = BigInt(ctx.from?.id ?? 0);
      const db = DatabaseService.getInstance();
      const user = await db.findUserByTelegramId(tid);
      if (!user) return;
      const { privateKeyHex, address } = generateWalletKeypair();
      const wallets = await db.findWalletsByUserId(user.id);
      const walletName = `Wallet ${wallets.length + 1}`;
      await db.createWallet({
        userId: user.id,
        address,
        name: walletName,
        encryptedKey: encrypt(privateKeyHex),
      });
      await ctx.reply(`✅ Wallet *${escapeMd(walletName)}* created!\n\nAddress: \`${address}\``, { parse_mode: "Markdown" });
      return walletsScreen(ctx);
    }
    if (action === "import_wallet") {
      ctx.session.waitingFor = "import_wallet";
      return ctx.reply("📥 Paste your Stacks private key:\n\n/cancel to abort.");
    }
    if (action === "delete_wallet") {
      ctx.session.waitingFor = "delete_wallet";
      return ctx.reply("🗑 Enter the wallet ID to delete:\n\n/cancel to abort.");
    }
    if (action === "reveal_wallet") {
      const tid = BigInt(ctx.from?.id ?? 0);
      const db = DatabaseService.getInstance();
      const user = await db.findUserByTelegramId(tid);
      if (!user) return;
      const wallets = await db.findWalletsByUserId(user.id);
      if (wallets.length === 0) return ctx.reply("No wallets.");
      // Show small list of wallets so user can pick by ID
      const lines = ["🔑 *Reveal Private Key*\n\nType `/reveal_N` for a wallet:\n"];
      wallets.forEach(w => lines.push(`/reveal\\_${w.id} — ${escapeMd(w.name)} \`${w.address.slice(0, 8)}...\``));
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
      return;
    }

    // ── Trade flow ──
    if (action === "trade_pick_pair") {
      delete ctx.session.tradePair;
      delete ctx.session.tradeDir;
      delete ctx.session.tradeAmount;
      return tradeScreen(ctx, "pick_pair");
    }
    if (action.startsWith("trade_token:")) {
      const symbol = action.slice(12);
      ctx.session.tradePair = `STX/${symbol}`;
      return tradeScreen(ctx, "pick_direction");
    }
    if (action.startsWith("trade_dir:")) {
      const dir = action.slice(10);
      ctx.session.tradeDir = dir;
      return tradeScreen(ctx, "enter_amount");
    }
    if (action === "trade_confirm") {
      const tid = BigInt(ctx.from?.id ?? 0);
      const db = DatabaseService.getInstance();
      const user = await db.findUserByTelegramId(tid);
      if (!user) return;
      const wallets = await db.findWalletsByUserId(user.id);
      if (wallets.length === 0) return ctx.reply("No wallet found.");
      const wallet = wallets[0]!;

      const pair = (ctx.session.tradePair as string) ?? "";
      const [tknIn, tknOut] = pair.split("/");
      const dir = (ctx.session.tradeDir as string) ?? "BUY";
      const tokenIn = dir === "BUY" ? (tknIn ?? "") : (tknOut ?? "");
      const tokenOut = dir === "BUY" ? (tknOut ?? "") : (tknIn ?? "");

      const rawAmount = ctx.session.tradeAmount;
      const amount = typeof rawAmount === "number" ? rawAmount : parseFloat(String(rawAmount ?? "0"));

      if (!tokenIn || !tokenOut || amount <= 0) {
        await ctx.answerCallbackQuery({ text: "Invalid trade parameters.", show_alert: true });
        return mainMenu(ctx);
      }

      const qm = (await import("../services/queue.js")).QueueManager.getInstance();
      await qm.enqueueTrade({
        walletId: wallet.id,
        userId: user.id,
        senderAddress: wallet.address,
        tokenIn,
        tokenOut,
        amountIn: amount,
        direction: dir as "BUY" | "SELL",
        reason: `Telegram trade: ${dir} ${amount} ${tokenIn} → ${tokenOut}`,
      });

      delete ctx.session.tradePair;
      delete ctx.session.tradeDir;
      delete ctx.session.tradeAmount;

      await ctx.answerCallbackQuery({ text: "✅ Trade enqueued!", show_alert: true });
      return mainMenu(ctx);
    }

    // ── Limit order creation flow ──
    if (action === "limit_create_pair") {
      delete ctx.session.limitPair;
      delete ctx.session.limitDir;
      delete ctx.session.limitAmount;
      delete ctx.session.limitPrice;
      return limitCreateScreen(ctx, "pick_pair");
    }
    if (action.startsWith("limit_token:")) {
      const symbol = action.slice(12);
      ctx.session.limitPair = `STX/${symbol}`;
      return limitCreateScreen(ctx, "pick_direction");
    }
    if (action.startsWith("limit_dir:")) {
      ctx.session.limitDir = action.slice(10);
      return limitCreateScreen(ctx, "enter_amount");
    }
    if (action === "limit_confirm") {
      const tid = BigInt(ctx.from?.id ?? 0);
      const db = DatabaseService.getInstance();
      const user = await db.findUserByTelegramId(tid);
      if (!user) return;
      const wallets = await db.findWalletsByUserId(user.id);
      if (wallets.length === 0) return ctx.reply("No wallet found.");

      const pair = (ctx.session.limitPair as string) ?? "";
      const [tknIn, tknOut] = pair.split("/");
      const dir = (ctx.session.limitDir as string) ?? "BUY";
      const tokenIn = dir === "BUY" ? (tknIn ?? "") : (tknOut ?? "");
      const tokenOut = dir === "BUY" ? (tknOut ?? "") : (tknIn ?? "");
      const rawLimitAmount = ctx.session.limitAmount;
      const amount = typeof rawLimitAmount === "number" ? rawLimitAmount : parseFloat(String(rawLimitAmount ?? "0"));
      const rawLimitPrice = ctx.session.limitPrice;
      const targetPrice = typeof rawLimitPrice === "number" ? rawLimitPrice : parseFloat(String(rawLimitPrice ?? "0"));

      if (!tokenIn || !tokenOut || amount <= 0 || targetPrice <= 0) {
        await ctx.answerCallbackQuery({ text: "Invalid parameters.", show_alert: true });
        return mainMenu(ctx);
      }

      await LimitOrderService.getInstance().create({
        userId: user.id,
        walletId: wallets[0]!.id,
        tokenIn,
        tokenOut,
        amountIn: amount,
        direction: dir as "BUY" | "SELL",
        targetPrice,
      });

      delete ctx.session.limitPair;
      delete ctx.session.limitDir;
      delete ctx.session.limitAmount;
      delete ctx.session.limitPrice;

      await ctx.answerCallbackQuery({ text: "✅ Limit order placed!", show_alert: true });
      return mainMenu(ctx);
    }

    // ── Stats / Broadcast callbacks ──
    if (data === "stats_cmd") {
      if (!isAdmin(ctx)) { await ctx.answerCallbackQuery({ text: "🔒 Admin only", show_alert: true }); return; }
      const s = await DatabaseService.getInstance().getStats();
      await ctx.reply(
        `📊 *System Stats*\n\nUsers: ${s.totalUsers}\nWallets: ${s.totalWallets}\nTrades: ${s.totalTrades}\nUptime: ${Math.floor(process.uptime() / 60)}m`,
        { parse_mode: "Markdown" }
      );
      return;
    }
    if (data === "broadcast_cmd") {
      if (!isAdmin(ctx)) { await ctx.answerCallbackQuery({ text: "🔒 Admin only", show_alert: true }); return; }
      ctx.session.waitingFor = "broadcast_msg";
      await ctx.reply("📢 *Broadcast Message*\n\nType the message to send to all Telegram users:", { parse_mode: "Markdown" });
      return;
    }

    return mainMenu(ctx);
  });

  // ════════════════════ Catch ════════════════════

  bot.catch((err) => {
    logger.error("Grammy error", { error: err.message });
  });

  logger.info("Bot router registered");
}

// ── NL Command Handler ──

async function handleNLCommand(ctx: BotContext, text: string): Promise<void> {
  const tid = BigInt(ctx.from?.id ?? 0);
  if (!tid) return;
  const user = await DatabaseService.getInstance().findUserByTelegramId(tid);
  if (!user) return;

  if (!ctx.session.chatHistory) {
    ctx.session.chatHistory = [];
  }
  const history = ctx.session.chatHistory.slice(-6);

  const ai = (await import("../services/ai.js")).AIOrchestrator.getInstance();
  const parsed = await ai.parseCommand(user.id, text, history);

  ctx.session.chatHistory.push({ role: "user", content: text });

  if (!parsed || parsed.action === "unknown") {
    const greetingRegex = /^(hello|hi|hey|greetings|good morning|good afternoon|good evening|yo)\b/i;
    if (greetingRegex.test(text)) {
      const reply = "👋 *Hello!* I am AstroidBot, your AI Stacks trading assistant.\n\n" +
        "I can help you with:\n" +
        "• *Trades*: e.g. `buy 10 STX for sUSDT`\n" +
        "• *Automated strategies*: DCA, Grid, and Portfolio Rebalancing\n" +
        "• *Wallets*: e.g. `show my wallets` or create/import wallets\n" +
        "• *Limit Orders*: e.g. `open limit orders`\n\n" +
        "Ask me anything or use the buttons below to navigate!";
      ctx.session.chatHistory.push({ role: "assistant", content: reply });
      ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);
      await ctx.reply(reply, { parse_mode: "Markdown" });
      return;
    }
    const fallback = "🤖 *AstroidBot Assistant*\n\n" +
      "I didn't quite catch that. Here are some things I can do for you:\n" +
      "• *Swaps*: `buy 10 STX`, `sell 5 ALEX`\n" +
      "• *Risk Limits*: `set slippage 200`\n" +
      "• *View Panels*: `show portfolio`, `list wallets`, `open orders`\n" +
      "• *Strategies*: `create rebalance strategy`\n\n" +
      "Type /help to see all commands.";
    ctx.session.chatHistory.push({ role: "assistant", content: fallback });
    ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);
    await ctx.reply(fallback, { parse_mode: "Markdown" });
    return;
  }

  const action = parsed.action as string;

  if (action === "chat") {
    const replyText = (parsed.replyText as string) || "How can I help you today?";
    const suggestedLink = parsed.suggestedLink as string | undefined;
    const suggestedScreen = parsed.suggestedScreen as string | undefined;

    ctx.session.chatHistory.push({ role: "assistant", content: replyText });
    ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);

    let kb: InlineKeyboard | undefined;
    if (suggestedLink) {
      const corsOrigin = ConfigManager.getInstance().config.CORS_ORIGIN || "http://localhost:5173";
      const linkUrl = corsOrigin.endsWith("/") && suggestedLink.startsWith("/")
        ? `${corsOrigin}${suggestedLink.slice(1)}`
        : `${corsOrigin}${suggestedLink}`;
      kb = new InlineKeyboard().url("🌐 Open Web Page", linkUrl);
    }

    if (kb) {
      await ctx.reply(replyText, { parse_mode: "Markdown", reply_markup: kb });
    } else {
      await ctx.reply(replyText, { parse_mode: "Markdown" });
    }

    if (suggestedScreen) {
      if (suggestedScreen === "main") return mainMenu(ctx);
      if (suggestedScreen === "portfolio") return portfolioScreen(ctx);
      if (suggestedScreen === "wallets") return walletsScreen(ctx);
      if (suggestedScreen === "orders") return ordersScreen(ctx);
      if (suggestedScreen === "settings") return settingsScreen(ctx);
      if (suggestedScreen === "trade") return tradeScreen(ctx, "pick_pair");
      if (suggestedScreen === "trades") return tradesScreen(ctx);
      if (suggestedScreen === "agents") return agentsScreen(ctx);
    }
    return;
  }

  if (action === "trade") {
    const t = (parsed.trade as Record<string, unknown> | undefined) ?? (parsed.tokenIn ? parsed : undefined);
    if (!t) return;
    const wallets = await DatabaseService.getInstance().findWalletsByUserId(user.id);
    const wallet = wallets[0];
    if (!wallet) {
      const reply = "No wallet found.";
      ctx.session.chatHistory.push({ role: "assistant", content: reply });
      ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);
      await ctx.reply(reply);
      return;
    }

    const qm = (await import("../services/queue.js")).QueueManager.getInstance();
    await qm.enqueueTrade({
      walletId: wallet.id, userId: user.id, senderAddress: wallet.address,
      tokenIn: (t.tokenIn as string) ?? "STX", tokenOut: (t.tokenOut as string) ?? "sUSDT",
      amountIn: (t.amountIn as number) ?? 1, direction: ((t.direction as string) ?? "BUY") as "BUY" | "SELL",
      reason: `NL: ${text}`,
    });
    const reply = `✅ Trade enqueued: ${(t.direction as string) ?? "BUY"} ${t.amountIn ?? ""} ${(t.tokenIn as string) ?? "STX"} → ${(t.tokenOut as string) ?? "sUSDT"}`;
    ctx.session.chatHistory.push({ role: "assistant", content: reply });
    ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);
    await ctx.reply(reply);
    return;
  }

  if (action === "info") {
    const topic = parsed.topic as string;
    const reply = `Opening your ${topic} screen.`;
    ctx.session.chatHistory.push({ role: "assistant", content: reply });
    ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);

    if (topic === "portfolio") return (await import("./screens/portfolioScreen.js")).portfolioScreen(ctx);
    if (topic === "wallets") return (await import("./screens/walletsScreen.js")).walletsScreen(ctx);
    if (topic === "orders") return (await import("./screens/ordersScreen.js")).ordersScreen(ctx);
    if (topic === "status" || topic === "settings") return (await import("./screens/settingsScreen.js")).settingsScreen(ctx);
    if (topic === "trades") return (await import("./screens/tradesScreen.js")).tradesScreen(ctx);
    if (topic === "agents") return (await import("./screens/agentsScreen.js")).agentsScreen(ctx);
  }

  if (action === "settings") {
    const key = parsed.key as string;
    const value = parsed.value as any;
    if (!key || value === undefined) return;
    const db = DatabaseService.getInstance();
    const s = await db.findTradeSettings(user.id, "personal");
    await db.upsertTradeSettings({
      userId: user.id, context: "personal",
      slippageBps: key === "slippageBps" ? Number(value) : s?.slippageBps,
      maxPositionPct: key === "maxPositionPct" ? Number(value) : s?.maxPositionPct,
      dailyLossLimit: key === "dailyLossLimit" ? Number(value) : s?.dailyLossLimit,
      rebalanceThreshold: key === "rebalanceThreshold" ? Number(value) : s?.rebalanceThreshold,
      useGasless: key === "useGasless" ? (value === true || value === "true" || value === 1 || value === "enabled") : s?.useGasless,
      gaslessFeeToken: key === "gaslessFeeToken" ? String(value) : s?.gaslessFeeToken,
    });
    const reply = `✅ ${key} set to ${value}`;
    ctx.session.chatHistory.push({ role: "assistant", content: reply });
    ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);
    await ctx.reply(reply);
    return;
  }

  if (action === "halt") {
    if (isAdmin(ctx)) {
      TelegramService.getInstance().setStatus(BotStatus.HALTED, `Admin halt via NL command: ${text}`);
      const reply = "🛑 Trading halted.";
      ctx.session.chatHistory.push({ role: "assistant", content: reply });
      ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);
      await ctx.reply(reply);
    } else {
      const reply = "❌ Only administrators can halt the trading engine.";
      ctx.session.chatHistory.push({ role: "assistant", content: reply });
      ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);
      await ctx.reply(reply);
    }
    return;
  }

  if (action === "resume") {
    if (isAdmin(ctx)) {
      TelegramService.getInstance().setStatus(BotStatus.RUNNING);
      const reply = "✅ Trading resumed.";
      ctx.session.chatHistory.push({ role: "assistant", content: reply });
      ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);
      await ctx.reply(reply);
    } else {
      const reply = "❌ Only administrators can resume the trading engine.";
      ctx.session.chatHistory.push({ role: "assistant", content: reply });
      ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);
      await ctx.reply(reply);
    }
    return;
  }

  if (action === "create_strategy") {
    const type = parsed.type as string;
    const config = parsed.config as Record<string, any>;
    if (!type || !config) return;
    const db = DatabaseService.getInstance();
    await db.prisma.tradingStrategy.create({
      data: {
        userId: user.id,
        type,
        config,
        isActive: true,
      }
    });
    const reply = `✅ Trading strategy *${type}* created successfully via AI.`;
    ctx.session.chatHistory.push({ role: "assistant", content: reply });
    ctx.session.chatHistory = ctx.session.chatHistory.slice(-6);
    await ctx.reply(reply, { parse_mode: "Markdown" });
    return;
  }
}
