import crypto from "node:crypto";
import { logger } from "../utils/logger.js";
import { DatabaseService } from "./db.js";
import { DEXRegistry } from "./dex/dexRegistry.js";
import { AIOrchestrator } from "./ai.js";
import { StrategyEngine, executeApprovedActions } from "./strategyEngine.js";
import { PortfolioManager } from "./portfolio.js";
import { NotificationService } from "./notificationService.js";
import { RiskManager } from "./riskManager.js";
import { buildAgentPrompt } from "./ai/prompts/agent.js";
import { AgentDecisionSchema } from "../validation/ai/schemas.js";
import type { RebalanceAction } from "../types.js";

interface AgentRunResult {
  actions: number;
  reason?: string;
  strategiesExecuted: number;
  aiDecision?: { action: string; reason: string };
}

export class AgentService {
  private static instance: AgentService;

  private constructor() { }

  static getInstance(): AgentService {
    if (!AgentService.instance) AgentService.instance = new AgentService();
    return AgentService.instance;
  }

  private async handleAgentSuccess(agentId: number): Promise<void> {
    const db = DatabaseService.getInstance();
    await db.prisma.tradeAgent.update({
      where: { id: agentId },
      data: { failureCount: 0 },
    });
  }

  private async handleAgentFailure(agentId: number, userId: number, errorMsg: string): Promise<void> {
    const db = DatabaseService.getInstance();
    const agent = await db.prisma.tradeAgent.findUnique({
      where: { id: agentId },
    });
    if (!agent) return;

    const newFailureCount = agent.failureCount + 1;
    if (newFailureCount >= 5) {
      await db.prisma.tradeAgent.update({
        where: { id: agentId },
        data: { failureCount: newFailureCount, isActive: false },
      });

      await db.prisma.auditLog.create({
        data: {
          userId,
          action: "AGENT_AUTO_DISABLE",
          details: `Agent ${agent.name} (ID: ${agentId}) automatically disabled after 5 consecutive failures. Last error: ${errorMsg}`,
        },
      });

      await NotificationService.getInstance().send({
        userId,
        title: "Agent Automatically Disabled",
        message: `Your agent "${agent.name}" has been disabled due to 5 consecutive failures. Last failure: ${errorMsg}`,
        type: "ERROR",
      });
    } else {
      await db.prisma.tradeAgent.update({
        where: { id: agentId },
        data: { failureCount: newFailureCount },
      });
    }
  }

  async runAgentCycle(agentId: number): Promise<AgentRunResult> {
    const db = DatabaseService.getInstance();
    const agent = await db.prisma.tradeAgent.findUnique({ where: { id: agentId } });
    if (!agent || !agent.isActive) {
      return { actions: 0, strategiesExecuted: 0, reason: "Agent not active" };
    }

    try {
      const wallets = await db.findWalletsByUserId(agent.userId);
      if (wallets.length === 0) {
        throw new Error("No wallets configured for user");
      }

      const registry = DEXRegistry.getInstance();
      const tokens = await registry.getSwappableTokens();
      const pm = PortfolioManager.getInstance();

      const updatedWallets = await Promise.all(
        wallets.map(async (w) => {
          try {
            const balances = await pm.fetchBalances(w.address, tokens, agent.userId);
            const stxBal = balances.find((b) => b.symbol === "STX")?.balance ?? 0;
            if (stxBal !== w.balance) {
              await db.updateWalletBalance(w.id, stxBal);
            }
            return { ...w, balance: stxBal };
          } catch {
            return w;
          }
        })
      );

      const state = (agent.state as Record<string, unknown>) ?? {};
      const cfg = (agent.config as Record<string, unknown>) ?? {};
      const aiMode = ((agent as { aiMode?: string }).aiMode) ?? "off";

      const strategies = await db.prisma.tradingStrategy.findMany({
        where: { agentId, userId: agent.userId, isActive: true },
      });

      let strategiesExecuted = 0;
      let actionsExecuted = 0;

      if (strategies.length > 0) {
        const result = await StrategyEngine.getInstance().runStrategies(
          strategies.map((s) => ({
            id: s.id, type: s.type, config: s.config as Record<string, unknown>, userId: s.userId,
          })),
        );
        strategiesExecuted = result.strategies;
        actionsExecuted += result.actions;
      }

      let aiDecision: { action: string; reason: string } | undefined;
      if (aiMode === "advisor" || aiMode === "autonomous") {
        const result = await this.runAiOverlay(agent, updatedWallets, state, cfg, aiMode === "autonomous");
        aiDecision = { action: result.action, reason: result.reason };
        if (result.executed) {
          actionsExecuted += 1;
        }
      }

      state.lastRun = new Date().toISOString();
      state.lastStrategiesExecuted = strategiesExecuted;
      state.lastActions = actionsExecuted;
      if (aiDecision) state.lastDecision = { ...aiDecision, time: new Date().toISOString() };

      await db.prisma.tradeAgent.update({
        where: { id: agent.id },
        data: { state: state as any },
      });

      await this.handleAgentSuccess(agentId);

      return {
        actions: actionsExecuted,
        strategiesExecuted,
        reason: aiDecision?.reason ?? `Ran ${strategiesExecuted} strategies`,
        aiDecision,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      logger.error("Agent cycle failed", { agentId: agent.id, error: err });
      await this.handleAgentFailure(agentId, agent.userId, errorMsg);
      throw err;
    }
  }

  private async runAiOverlay(
    agent: { id: number; userId: number; name: string; context: string; model: string; config: unknown; state: unknown },
    wallets: Array<{ id: number; address: string; balance: number }>,
    state: Record<string, unknown>,
    config: Record<string, unknown>,
    autonomous: boolean,
  ): Promise<{ action: string; reason: string; executed: boolean }> {
    const ai = AIOrchestrator.getInstance();
    const db = DatabaseService.getInstance();

    let stxPrice = 0;
    try { stxPrice = await DEXRegistry.getInstance().getTokenPrice("STX"); } catch { }

    const prompt = buildAgentPrompt(agent, wallets, state, config, stxPrice);
    
    let decision;
    try {
      decision = await ai.request({
        task: `agent-${agent.id}`,
        prompt,
        schema: AgentDecisionSchema,
        userId: agent.userId,
        cacheTTL: 0,
      });
    } catch (err) {
      logger.error("AI agent decision request failed", { error: err });
      return { action: "hold", reason: "AI request failed", executed: false };
    }

    let executed = false;

    if (autonomous && decision.action === "trade" && decision.trade) {
      const t = decision.trade;
      const wallet = wallets.find((w) => w.id === (t.walletId ?? wallets[0]?.id));
      if (wallet) {
          const settings = await db.findTradeSettings(agent.userId, "personal");
          const maxPct = (config.maxPositionPct as number) ?? (settings?.maxPositionPct ?? 25);
          const maxAmount = (wallet.balance * maxPct) / 100;
          const perRunCap = Number(config.maxAutonomousTradeAmount ?? maxAmount);
          const cappedAmount = Math.min(t.amountIn, maxAmount, Number.isFinite(perRunCap) && perRunCap > 0 ? perRunCap : maxAmount);

        const action: RebalanceAction = {
          tokenIn: t.tokenIn ?? "STX",
          tokenOut: t.tokenOut,
          amountIn: cappedAmount,
          direction: t.direction,
          reason: `Agent "${agent.name}" (AI): ${t.reason ?? "autonomous"}`,
        };

        const tokens = await DEXRegistry.getInstance().getSwappableTokens();
        const balances = await PortfolioManager.getInstance().fetchBalances(wallet.address, tokens, agent.userId);

          const riskSettings = {
            slippageBps: settings?.slippageBps ?? 100,
            maxPositionPct: maxPct,
            dailyLossLimit: Math.min(settings?.dailyLossLimit ?? 5, 100),
          };

          const { approved } = await RiskManager.getInstance().evaluateActions(
          agent.userId,
          [action],
          balances,
          riskSettings
        );

          if (approved.length > 0) {
            await db.prisma.auditLog.create({
              data: {
                userId: agent.userId,
                action: "AI_AUTONOMOUS_TRADE_APPROVED",
                details: JSON.stringify({
                  agentId: agent.id,
                  action,
                  reason: decision.reason,
                }),
              },
            });
            const res = await executeApprovedActions(
              approved,
              wallet.id,
            agent.userId,
            wallet.address,
            riskSettings.slippageBps
          );
          if (res.executed > 0) {
            executed = true;
            }
          } else {
            await db.prisma.auditLog.create({
              data: {
                userId: agent.userId,
                action: "AI_AUTONOMOUS_TRADE_REJECTED",
                details: JSON.stringify({
                  agentId: agent.id,
                  action,
                  reason: decision.reason,
                }),
              },
            });
            logger.warn("AI agent trade action rejected by RiskManager", { agentId: agent.id });
          }
      }
    }

    return {
      action: decision.action,
      reason: decision.reason,
      executed,
    };
  }
}
