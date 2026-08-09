import type { Server } from "node:http";
import { ConfigManager } from "./config.js";
import { logger } from "./utils/logger.js";
import { hardenOutboundHttp, installProcessGuards, connectDatabase } from "./runtime.js";
import { AlexDEXService } from "./services/dex/alex.js";
import { BitflowDEXService } from "./services/dex/bitflow.js";
import { VelarDEXService } from "./services/dex/velar.js";
import { DEXRegistry } from "./services/dex/dexRegistry.js";
import { registerEnabledChains } from "./services/chains/registerChains.js";
import { registerSocialProviders } from "./services/social/socialRegistry.js";
import { TelegramService } from "./services/telegram.js";
import { createServer } from "./api/server.js";
import { BotStatus } from "./types.js";


export async function bootstrap(): Promise<Server> {
  logger.info("AstroidBot initializing...");

  // Shared with src/indexer.ts — see runtime.ts for why these two steps are
  // not optional for any process that makes an outbound request.
  hardenOutboundHttp();
  installProcessGuards();

  ConfigManager.load();

  await connectDatabase();

  await AlexDEXService.initialize();
  const alex = AlexDEXService.getInstance();
  const tokens = await alex.getSwappableTokens(true);
  logger.info(`Loaded ${tokens.length} ALEX swappable tokens`);

  BitflowDEXService.initialize();
  const bitflow = BitflowDEXService.getInstance();
  bitflow.getPools(true).then((pools) => {
    logger.info(`Loaded ${pools.length} Bitflow pools`);
  }).catch((err) => {
    logger.warn("Bitflow pool prefetch failed", { error: err });
  });

  VelarDEXService.initialize();
  const velar = VelarDEXService.getInstance();
  velar.getSwappableTokens(true).then((vTokens) => {
    logger.info(`Loaded ${vTokens.length} Velar swappable tokens`);
  }).catch((err) => {
    logger.warn("Velar token prefetch failed", { error: err });
  });

  const registry = DEXRegistry.getInstance();
  registry.registerProvider(bitflow);
  registry.registerProvider(alex);
  registry.registerProvider(velar);

  // Chain adapters and their DEX providers come from ENABLED_CHAINS — one
  // list, one registration path, whatever the family. Defaults to
  // "stacks:mainnet", so a deployment that sets nothing is Stacks-only exactly
  // as before. Misconfiguration throws here rather than surfacing later as a
  // chain that mysteriously isn't enabled.
  registerEnabledChains();

  // Social platforms are registered only when SOCIAL_TRADING_ENABLED is set
  // *and* credentials exist — a stray API key must not be enough to start
  // acting on public posts.
  registerSocialProviders();

  const httpServer = createServer();

  const telegram = TelegramService.getInstance();

  if (telegram.isEnabled()) {
    await telegram.start();
  }

  telegram.setStatus(BotStatus.RUNNING);

  return httpServer;
}
