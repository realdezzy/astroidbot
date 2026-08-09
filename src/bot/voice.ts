import { logger } from "../utils/logger.js";
import { ConfigManager } from "../config.js";
import { DatabaseService } from "../services/db.js";
import axios from "axios";
import { spawn } from "child_process";
import OpenAI, { toFile } from "openai";
import { handleNLCommand } from "./nl.js";
import type { BotContext } from "../types/bot.js";

/** Voice-note transcription, then the same NL path text commands take. */
export async function handleVoice(ctx: BotContext): Promise<unknown> {
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
        try { await ctx.api.deleteMessage(ctx.chat!.id, waitMsg.message_id); } catch { }
        return ctx.reply("🔇 Could not hear or understand the audio. Please speak clearly.");
      }

      try { await ctx.api.deleteMessage(ctx.chat!.id, waitMsg.message_id); } catch { }
      await ctx.reply(`🎤 *You said:* "${transcriptionText}"`, { parse_mode: "Markdown" });

      await handleNLCommand(ctx, transcriptionText);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Voice transcription failed", { error: msg });
      await ctx.reply("❌ Voice transcription failed. Please type your command instead, e.g. 'buy 5 STX for USDCx' or 'show portfolio'.");
    }
}
