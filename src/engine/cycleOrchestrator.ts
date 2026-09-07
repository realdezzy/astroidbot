import { logger } from "../utils/logger.js";
import { DatabaseService } from "../services/db.js";
import { DEXRegistry } from "../services/dex/dexRegistry.js";
import { RiskManager } from "../services/riskManager.js";
import { confirmSwap } from "../services/chains/executeSwap.js";
import { walletChainId } from "../services/chains/walletChain.js";
import { TelegramService } from "../services/telegram.js";
import { WebSocketManager } from "../api/websocket.js";
import { BotStatus } from "../types.js";
import { executeLimitOrderCycle } from "./limitOrderCycle.js";
import { StrategyEngine } from "../services/strategyEngine.js";
import { AgentService } from "../services/agentService.js";
import { TokenDiscoveryService } from "../services/tokenDiscovery.js";
import { pollSocialMentions } from "../services/social/socialRegistry.js";


export async function runCycle(): Promise<void> {
  const telegram = TelegramService.getInstance();
  const status = telegram.getStatus();

  if (status.status !== BotStatus.RUNNING) {
    logger.info(`Skipping cycle: bot is ${status.status}`);
    return;
  }

  logger.info("Starting bot cycle");

  try {
    const db = DatabaseService.getInstance();
    const registry = DEXRegistry.getInstance();
    const risk = RiskManager.getInstance();
    const wss = WebSocketManager.getInstance();

    // Token catalogue refresh rides the existing global tick rather than
    // introducing a second scheduler — there is exactly one periodic mechanism
    // in this codebase on purpose. Fire-and-forget: discovery is a read-side
    // convenience and must never delay or fail a trading cycle.
    TokenDiscoveryService.getInstance()
      .syncAll()
      .catch((err) => logger.warn("Token discovery sync failed", { error: err }));

    // Social mentions ride the same tick. Fire-and-forget for the same reason
    // as discovery: an inbound-command failure must never delay or fail a
    // trading cycle.
    pollSocialMentions().catch((err) =>
      logger.warn("Social mention poll failed", { error: err })
    );

    const tokens = await registry.getSwappableTokens();
    if (tokens.length === 0) {
      logger.warn("No swappable tokens available — skipping cycle");
      return;
    }

    // Projected, not `include: { user: true }`. The cycle uses five columns;
    // the include pulled every wallet row of every active user in full —
    // encrypted private keys and all — into memory once a minute, to read the
    // id off each. Keys are decrypted just-in-time inside TransactionService,
    // and there is no reason for this loop to be holding them at all.
    const wallets = await db.prisma.wallet.findMany({
      where: { user: { isActive: true } },
      select: { id: true, userId: true, address: true, chainFamily: true, chain: true },
    });

    let totalActionsExecuted = 0;
    let totalDailyPnl = 0;

    // Run strategy engine for users with active strategies (non-agent strategies only)
    const strategyResult = await StrategyEngine.getInstance().runCycle();
    totalActionsExecuted += strategyResult.actionsExecuted;

    // Agent cycles, run a few at a time.
    //
    // These were dispatched all at once with a bare `.catch()` — N active
    // agents meant N concurrent LLM calls and N concurrent quote fetches with
    // no ceiling, every tick. That is a self-inflicted rate-limit spike
    // against both the AI provider and the DEX routers, and it grows with
    // adoption. Still not awaited by the cycle as a whole: an agent is
    // independent of the trading pass and must not delay it.
    const activeAgents = await db.prisma.tradeAgent.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    if (activeAgents.length > 0) {
      logger.info("Agent cycles dispatched", { count: activeAgents.length });
      void runAgentCycles(activeAgents.map((a) => a.id));
    }

    // Retry pending confirmations from previous cycles (single-check per cycle).
    const pendingTrades = await db.findPendingTrades();
    for (const trade of pendingTrades) {
      confirmSwap(trade.txId ?? "dry-run-tx-id", trade.id, walletChainId(trade.wallet)).then((state) => {
        if (state === "confirmed") {
          wss.broadcastTradeEvent(trade.userId, "trade_confirmed", {
            tradeId: trade.id,
            txId: trade.txId,
          });
        } else if (state === "failed") {
          wss.broadcastTradeEvent(trade.userId, "trade_failed", {
            tradeId: trade.id,
            txId: trade.txId,
            error: "Transaction failed or timed out",
          });
        }
      }).catch((err) => {
        logger.error("Confirmation retry failed", { tradeId: trade.id, error: err });
      });
    }

    const { executed: limitOrdersExecuted } = await executeLimitOrderCycle(wallets, tokens);
    totalActionsExecuted += limitOrdersExecuted;

    // Per user, not per wallet. Daily P&L is an account-level figure, so a
    // user with four wallets was having it queried four times and *summed*
    // four times into the number broadcast to every connected client.
    const userIds = [...new Set(wallets.map((w) => w.userId))];
    const pnls = await Promise.all(
      userIds.map((userId) =>
        risk.getDailyPnl(userId).catch((err) => {
          logger.warn("Daily PnL lookup failed", { userId, error: err });
          return 0;
        })
      )
    );
    totalDailyPnl = pnls.reduce((sum, pnl) => sum + pnl, 0);

    await awardCyclePoints(db);

    wss.broadcastCycleComplete({
      actionsExecuted: totalActionsExecuted,
      dailyPnl: totalDailyPnl,
      timestamp: new Date().toISOString(),
    });

    logger.info("Bot cycle complete");
  } catch (error) {
    logger.error("Bot cycle failed", { error });

    if (telegram.isEnabled()) {
      await telegram.sendAlert(
        0,
        `Cycle error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
}

/**
 * Ticks between point awards.
 *
 * Points accrue at one per cycle per active user, which is the product
 * behaviour and is preserved exactly — the award is simply batched, granting
 * `POINTS_EVERY_N_CYCLES` at a time. The write is an unqualified `updateMany`
 * over every active user, so at one per minute it rewrote the whole table
 * 1,440 times a day, producing that many dead row versions for autovacuum to
 * clear, to hand out a number nothing reads in real time.
 */
const POINTS_EVERY_N_CYCLES = 30;

let cyclesSincePoints = 0;

async function awardCyclePoints(db: DatabaseService): Promise<void> {
  if (++cyclesSincePoints < POINTS_EVERY_N_CYCLES) return;

  const earned = cyclesSincePoints;
  cyclesSincePoints = 0;

  await db.prisma.user.updateMany({
    where: { isActive: true },
    data: { points: { increment: earned } },
  });
}

/** Test seam: the award counter is module state and would leak between suites. */
export function resetCyclePoints(): void {
  cyclesSincePoints = 0;
}

/**
 * Agents in flight at once.
 *
 * Each cycle can make an LLM call and several quote requests, so this is the
 * knob that decides how hard one tick hits the AI provider and the routers.
 * Five is well inside every provider's concurrency allowance and still drains
 * a few hundred agents inside a minute.
 */
const AGENT_CONCURRENCY = 5;

async function runAgentCycles(agentIds: number[]): Promise<void> {
  const agentService = AgentService.getInstance();

  for (let i = 0; i < agentIds.length; i += AGENT_CONCURRENCY) {
    await Promise.all(
      agentIds.slice(i, i + AGENT_CONCURRENCY).map((agentId) =>
        agentService.runAgentCycle(agentId).catch((err) => {
          logger.error("Agent cycle failed", { agentId, error: err });
        })
      )
    );
  }
}
