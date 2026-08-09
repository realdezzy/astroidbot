import { DatabaseService } from "../services/db.js";
import { ChainAdapterRegistry } from "../services/chains/chainAdapterRegistry.js";
import { DEXRegistry } from "../services/dex/dexRegistry.js";
import { walletChainId } from "../services/chains/walletChain.js";
import { findDescriptor, DEFAULT_CHAIN_ID } from "../services/chains/descriptors/index.js";
import type { BotContext } from "../types/bot.js";
import type { ChainDescriptor } from "../types/chain.js";
import type { SwappableToken } from "../types.js";

/**
 * Which chain is this Telegram user currently acting on?
 *
 * Resolution order: an explicit session choice, then the user's default
 * wallet's chain, then the deployment default. Everything chain-scoped in the
 * bot — token pickers, quotes, orders, native-symbol labels — goes through
 * here, so a Base token can no longer appear in a Stacks wallet's picker.
 */
export async function activeChainId(ctx: BotContext): Promise<string> {
  if (ctx.session.activeChainId) return ctx.session.activeChainId;

  const db = DatabaseService.getInstance();
  const user = await db.findUserByTelegramId(BigInt(ctx.from?.id ?? 0));
  if (!user) return DEFAULT_CHAIN_ID;

  const wallet = await db.findDefaultWalletByUserId(user.id);
  if (!wallet) return DEFAULT_CHAIN_ID;

  const chainId = walletChainId(wallet);
  ctx.session.activeChainId = chainId;
  return chainId;
}

/** Descriptor for the active chain. Never throws — display code needs labels
 *  even when the chain has since been disabled. */
export async function activeChain(ctx: BotContext): Promise<ChainDescriptor> {
  const chainId = await activeChainId(ctx);
  const registry = ChainAdapterRegistry.getInstance();
  if (registry.has(chainId)) return registry.get(chainId).descriptor;
  return findDescriptor(chainId) ?? findDescriptor(DEFAULT_CHAIN_ID)!;
}

/** The active chain's native ticker — replaces every hardcoded "STX". */
export async function activeNativeSymbol(ctx: BotContext): Promise<string> {
  return (await activeChain(ctx)).nativeSymbol;
}

/** The active chain's USD stablecoin — replaces every hardcoded "USDCx". */
export async function activeStableSymbol(ctx: BotContext): Promise<string> {
  return (await activeChain(ctx)).stableSymbol;
}

/**
 * Token list scoped to the active chain.
 *
 * The unscoped DEXRegistry.getSwappableTokens() returns every provider's
 * tokens across every chain; showing that in a picker lets a user select a
 * Base token for a Stacks wallet, which then fails at quote time with an
 * unhelpful "no route".
 */
export async function activeChainTokens(ctx: BotContext): Promise<SwappableToken[]> {
  return DEXRegistry.getInstance().getSwappableTokens(false, await activeChainId(ctx));
}

/** Sets the active chain, clearing selections that belonged to the old one. */
export function setActiveChain(ctx: BotContext, chainId: string): void {
  if (ctx.session.activeChainId === chainId) return;
  ctx.session.activeChainId = chainId;
  // A token symbol means nothing across chains — carrying "USDC" from Base to
  // Celo would silently point at a different asset.
  delete ctx.session.tradeTokenIn;
  delete ctx.session.tradeTokenOut;
  delete ctx.session.tradePair;
  delete ctx.session.tradeAmount;
}
