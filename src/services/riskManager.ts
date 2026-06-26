import { logger } from "../utils/logger.js";
import { DatabaseService } from "./db.js";
import type { RebalanceAction, TokenBalance } from "../types.js";

interface RiskEvaluation {
  approved: boolean;
  reason?: string;
}

export class RiskManager {
  private static instance: RiskManager;
  private dailyPnlReported = false;

  private constructor() {
  }

  static getInstance(): RiskManager {
    if (!RiskManager.instance) {
      RiskManager.instance = new RiskManager();
    }
    return RiskManager.instance;
  }

  async evaluateTrade(
    userId: number,
    action: RebalanceAction,
    currentBalances: TokenBalance[],
    settings: {
      slippageBps: number;
      maxPositionPct: number;
      dailyLossLimit: number;
    }
  ): Promise<RiskEvaluation> {
    const totalValue = currentBalances.reduce(
      (sum, b) => sum + b.usdValue,
      0
    );

    if (totalValue <= 0) {
      return { approved: false, reason: "Portfolio has no value" };
    }

    const dailyPnl = await this.calculateDailyPnl(userId);
    if (dailyPnl < -settings.dailyLossLimit) {
      if (!this.dailyPnlReported) {
        logger.warn("Daily loss limit reached", {
          dailyPnl: dailyPnl.toFixed(2),
          limit: settings.dailyLossLimit,
        });
        this.dailyPnlReported = true;
      }
      return {
        approved: false,
        reason: `Daily loss limit reached: ${dailyPnl.toFixed(2)}%`,
      };
    }

    if (action.direction === "SELL") {
      const tokenBalance = currentBalances.find(
        (b) => b.symbol === action.tokenIn ||
          b.token === action.tokenIn
      );
      if (!tokenBalance || tokenBalance.balance < action.amountIn) {
        return {
          approved: false,
          reason: `Insufficient ${action.tokenIn} balance for sell`,
        };
      }
    }

    if (action.direction === "BUY") {
      const tokenOutBalance = currentBalances.find(
        (b) =>
          b.symbol === action.tokenOut || b.token === action.tokenOut
      );
      const currentUsdValue = tokenOutBalance?.usdValue ?? 0;
      const newUsdValue = currentUsdValue + action.amountIn * 2.0;
      const newPct = (newUsdValue / totalValue) * 100;

      if (newPct > settings.maxPositionPct) {
        return {
          approved: false,
          reason: `Would exceed max position for ${action.tokenOut}: ${newPct.toFixed(1)}% > ${settings.maxPositionPct}%`,
        };
      }
    }

    if (action.direction === "SELL") {
      const currentBalance = currentBalances.find(
        (b) =>
          b.symbol === action.tokenIn || b.token === action.tokenIn
      );
      if (currentBalance) {
        const sellPct =
          (action.amountIn / currentBalance.balance) * 100;
        if (sellPct > 50) {
          return {
            approved: false,
            reason: `Sell exceeds 50% of ${action.tokenIn} position (${sellPct.toFixed(1)}%)`,
          };
        }
      }
    }

    return { approved: true };
  }

  evaluateActions(
    userId: number,
    actions: RebalanceAction[],
    balances: TokenBalance[],
    settings: {
      slippageBps: number;
      maxPositionPct: number;
      dailyLossLimit: number;
    }
  ): Promise<{ approved: RebalanceAction[]; rejected: Array<{ action: RebalanceAction; reason: string }> }> {
    const approved: RebalanceAction[] = [];
    const rejected: Array<{ action: RebalanceAction; reason: string }> = [];

    const evaluatePromises = actions.map(async (action) => {
      const result = await this.evaluateTrade(
        userId,
        action,
        balances,
        settings
      );
      if (result.approved) {
        approved.push(action);
      } else {
        rejected.push({ action, reason: result.reason ?? "Unknown" });
      }
    });

    return Promise.all(evaluatePromises).then(() => ({ approved, rejected }));
  }

  async resetDailyLossReporting(): Promise<void> {
    this.dailyPnlReported = false;
  }

  async getDailyPnl(userId: number): Promise<number> {
    return this.calculateDailyPnl(userId);
  }

  private async calculateDailyPnl(userId: number): Promise<number> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    try {
      const trades = await DatabaseService.getInstance().getDailyTradesSince(
        userId,
        today
      );

      if (trades.length === 0) return 0;

      let totalPnl = 0;
      for (const trade of trades) {
        if (trade.status === "CONFIRMED" || trade.status === "BROADCAST") {
          if (trade.direction === "BUY") {
            totalPnl -= trade.amountIn;
          } else {
            totalPnl += trade.amountOut - trade.amountIn;
          }
        }
      }

      return totalPnl;
    } catch {
      logger.error("Failed to calculate daily PnL");
      return 0;
    }
  }
}
