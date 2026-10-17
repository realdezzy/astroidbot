/**
 * Strips Stacks token defaults from strategies that run only off Stacks.
 *
 * The strategy config schema defaulted unset token legs to STX/USDCx, and the
 * create form pre-filled STX/sUSDT. Both were persisted with the strategy, so
 * every Base, Solana or other non-Stacks strategy created without explicit
 * tokens was saved holding tokens its wallet's chain cannot route, and kept
 * them after the defaults were removed. Removing the legs lets the strategy
 * fill them from the wallet's chain at run time, which is what it does for
 * strategies created since.
 *
 * What is and isn't touched is decided by `planStaleTokenRepair` — see there.
 * Strategies with a Stacks wallet are reported and left alone.
 *
 *   npx tsx scripts/repair-strategy-token-defaults.ts            # report only
 *   npx tsx scripts/repair-strategy-token-defaults.ts --apply    # update
 *
 * Dry by default: this rewrites user configuration, so it should not be what
 * happens when you forget a flag.
 */
import { ConfigManager } from "../src/config.js";
import { DatabaseService } from "../src/services/db.js";
import { walletChainId } from "../src/services/chains/walletChain.js";
import { planStaleTokenRepair } from "../src/services/strategy/staleTokenDefaults.js";
import { logger } from "../src/utils/logger.js";

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  ConfigManager.load();
  const db = DatabaseService.connect();

  // Inactive strategies included: resuming one should not resume it broken.
  const strategies = await db.prisma.tradingStrategy.findMany({
    select: { id: true, userId: true, type: true, config: true },
  });

  const repairs: { id: number; config: Record<string, unknown>; removed: Record<string, string> }[] = [];
  const skipped: Record<string, number[]> = {};

  for (const strategy of strategies) {
    const config = (strategy.config ?? {}) as Record<string, unknown>;
    const walletIds = Array.isArray(config.walletIds)
      ? config.walletIds.filter((id): id is number => typeof id === "number")
      : [];
    // Scoped to the strategy's owner, matching what the engine will run.
    const wallets = walletIds.length === 0
      ? []
      : await db.prisma.wallet.findMany({
          where: { id: { in: walletIds }, userId: strategy.userId },
          select: { chain: true, chainFamily: true },
        });

    const plan = planStaleTokenRepair(config, wallets.map(walletChainId));
    if (plan.action === "repair") {
      repairs.push({ id: strategy.id, config: plan.config, removed: plan.removed });
    } else {
      (skipped[plan.reason] ??= []).push(strategy.id);
    }
  }

  logger.info("[repair-strategy-token-defaults] scanned", {
    total: strategies.length,
    toRepair: repairs.length,
    repairs: repairs.map(({ id, removed }) => ({ id, removed })),
    // Listed by id: these keep their tokens and may need a look by hand.
    skippedWithStacksWallet: skipped.has_stacks_wallet ?? [],
    skippedWithoutWallets: (skipped.no_wallets ?? []).length,
  });

  if (!apply) {
    if (repairs.length > 0) {
      logger.warn(
        `[repair-strategy-token-defaults] ${repairs.length} strateg(ies) would be updated. Re-run with --apply.`
      );
    }
    await db.disconnect();
    return;
  }

  for (const { id, config } of repairs) {
    await db.prisma.tradingStrategy.update({
      where: { id },
      data: { config: config as object },
    });
  }
  logger.info("[repair-strategy-token-defaults] updated", { count: repairs.length });

  await db.disconnect();
}

main().catch((error) => {
  logger.error("[repair-strategy-token-defaults] failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
