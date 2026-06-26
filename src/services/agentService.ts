import crypto from "node:crypto";
import { logger } from "../utils/logger.js";
import { DatabaseService } from "./db.js";
import { DEXRegistry } from "./dex/dexRegistry.js";
import { AIOrchestrator } from "./ai.js";
import { QueueManager } from "./queue.js";
import { StrategyEngine } from "./strategyEngine.js";
import { PortfolioManager } from "./portfolio.js";


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

  /**
   * Run one cycle for an agent:
   *   1. Execute all of the agent's deterministic strategies via StrategyEngine.
   *   2. If aiMode != "off", invoke the AI overlay for an additional decision.
   */
  async runAgentCycle(agentId: number): Promise<AgentRunResult> {
    const db = DatabaseService.getInstance();
    const agent = await db.prisma.tradeAgent.findUnique({ where: { id: agentId } });
    if (!agent || !agent.isActive) {
      return { actions: 0, strategiesExecuted: 0, reason: "Agent not active" };
    }

    const wallets = await db.findWalletsByUserId(agent.userId);
    if (wallets.length === 0) {
      return { actions: 0, strategiesExecuted: 0, reason: "No wallets" };
    }

    const registry = DEXRegistry.getInstance();
    const tokens = await registry.getSwappableTokens();
    const pm = PortfolioManager.getInstance();

    const updatedWallets = await Promise.all(
      wallets.map(async (w) => {
        try {
          const balances = await pm.fetchBalances(w.address, tokens, agent.userId);
          const stxBal = balances.find((b) => b.symbol === "STX")?.balance ?? 0;
          await db.updateWalletBalance(w.id, stxBal);
          return { ...w, balance: stxBal };
        } catch {
          return w;
        }
      })
    );

    const state = (agent.state as Record<string, unknown>) ?? {};
    const cfg = (agent.config as Record<string, unknown>) ?? {};
    const aiMode = ((agent as { aiMode?: string }).aiMode) ?? "off";

    // 1. Execute deterministic strategies belonging to this agent
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

    // 2. Optional AI overlay
    let aiDecision: { action: string; reason: string } | undefined;
    if (aiMode === "advisor" || aiMode === "autonomous") {
      try {
        aiDecision = await this.runAiOverlay(agent, updatedWallets, state, cfg, aiMode === "autonomous");
        if (aiDecision && aiMode === "autonomous" && aiDecision.action === "trade") {
          actionsExecuted += 1;
        }
      } catch (err) {
        logger.warn(`Agent ${agent.name} AI overlay failed`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Update state
    state.lastRun = new Date().toISOString();
    state.lastStrategiesExecuted = strategiesExecuted;
    state.lastActions = actionsExecuted;
    if (aiDecision) state.lastDecision = { ...aiDecision, time: new Date().toISOString() };

    await db.prisma.tradeAgent.update({
      where: { id: agent.id },
      data: { state: state as any },
    });

    return {
      actions: actionsExecuted,
      strategiesExecuted,
      reason: aiDecision?.reason ?? `Ran ${strategiesExecuted} strategies`,
      aiDecision,
    };
  }

  private async runAiOverlay(
    agent: { id: number; userId: number; name: string; context: string; model: string; config: unknown; state: unknown },
    wallets: Array<{ id: number; address: string; balance: number }>,
    state: Record<string, unknown>,
    config: Record<string, unknown>,
    autonomous: boolean,
  ): Promise<{ action: string; reason: string }> {
    const ai = AIOrchestrator.getInstance();
    const db = DatabaseService.getInstance();

    let stxPrice = 0;
    try { stxPrice = await DEXRegistry.getInstance().getTokenPrice("STX"); } catch { }

    const prompt = this.buildAgentPrompt(agent, wallets, state, config, stxPrice);
    const response = await ai.callLLM(agent.userId, `agent-${agent.id}`, prompt);
    const decision = JSON.parse(response);

    const inputHash = crypto.createHash("sha256").update(prompt).digest("hex");
    await db.createAIRecommendation({
      userId: agent.userId,
      context: `agent-${agent.id}`,
      inputHash,
      modelProvider: agent.model,
      modelName: agent.model,
      promptTokens: 0,
      completionTokens: 0,
      recommendation: decision,
    });

    if (autonomous && decision.action === "trade" && decision.trade) {
      const t = decision.trade;
      const wallet = wallets.find((w) => w.id === (t.walletId ?? wallets[0]?.id));
      if (wallet) {
        const maxPct = (config.maxPositionPct as number) ?? 25;
        const maxAmount = (wallet.balance * maxPct) / 100;
        const cappedAmount = Math.min(t.amountIn ?? 1, maxAmount);

        await QueueManager.getInstance().enqueueTrade({
          walletId: wallet.id,
          userId: agent.userId,
          senderAddress: wallet.address,
          tokenIn: t.tokenIn ?? "STX",
          tokenOut: t.tokenOut ?? "sUSDT",
          amountIn: cappedAmount,
          direction: t.direction ?? "BUY",
          reason: `Agent "${agent.name}" (AI): ${t.reason ?? "autonomous"}`,
        });
      }
    }

    return {
      action: decision.action ?? "hold",
      reason: decision.reason ?? "No reason provided",
    };
  }

  private buildAgentPrompt(
    agent: { name: string; context: string; config: unknown; state: unknown },
    wallets: Array<{ id: number; address: string; balance: number }>,
    state: Record<string, unknown>,
    config: Record<string, unknown>,
    stxPrice: number,
  ): string {
    const walletInfo = wallets
      .map((w) => `#${w.id} ${w.address.slice(0, 10)}... balance: ${w.balance.toFixed(2)} STX`)
      .join("\n");

    return `You are an autonomous trading agent named "${agent.name}" on the Stacks blockchain.

Context: ${agent.context}
Config: ${JSON.stringify(config)}
Current state: ${JSON.stringify(state)}
STX Price: $${stxPrice > 0 ? stxPrice.toFixed(4) : "unknown"}

Wallets:
${walletInfo}

Available tokens on ALEX: STX, sUSDT, USDA, ALEX, WELSH, DIKO, and others.

Rules:
- Never trade more than ${config.maxPositionPct ?? 25}% of a wallet's balance in one trade
- If STX price is unknown or you're unsure, prefer "hold"
- Diversify across available tokens
- Respond ONLY with valid JSON, nothing else:

{
  "action": "trade" | "hold",
  "reason": "brief explanation",
  "trade": {
    "walletId": number,
    "tokenIn": "STX",
    "tokenOut": "sUSDT",
    "amountIn": 1.0,
    "direction": "BUY" | "SELL",
    "reason": "why"
  }
}`;
  }
}
