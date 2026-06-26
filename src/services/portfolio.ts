import axios from "axios";
import { ConfigManager } from "../config.js";
import { logger } from "../utils/logger.js";
import { DEXRegistry } from "./dex/dexRegistry.js";
import { DatabaseService } from "./db.js";
import type {
  PortfolioTarget,
  RebalanceAction,
  TokenBalance,
  SwappableToken,
} from "../types.js";

interface StacksBalance {
  stx: {
    balance: string;
    total_sent: string;
    total_received: string;
  };
  fungible_tokens: Record<string, { balance: string }>;
}

export class PortfolioManager {
  private static instance: PortfolioManager;
  private readonly dustThresholdUsd: number;

  private constructor() {
    this.dustThresholdUsd = ConfigManager.getInstance().config.DUST_THRESHOLD_USD;
  }

  static getInstance(): PortfolioManager {
    if (!PortfolioManager.instance) {
      PortfolioManager.instance = new PortfolioManager();
    }
    return PortfolioManager.instance;
  }

  async fetchBalances(
    address: string,
    swappableTokens: SwappableToken[],
    userId?: number
  ): Promise<TokenBalance[]> {
    const balances: TokenBalance[] = [];
    const config = ConfigManager.getInstance().config;

    let userBlockedSet = new Set<string>();
    if (userId) {
      try {
        const db = DatabaseService.getInstance();
        const userBlocked = await db.getBlockedTokens(userId);
        userBlockedSet = new Set(userBlocked.map((b) => b.contractId));
      } catch {
        // Blocked token lookup failed, proceed without per-user blocking
      }
    }

    try {
      const headers: Record<string, string> = {};
      if ((config as any).HIRO_API_KEY) {
        headers["x-api-key"] = (config as any).HIRO_API_KEY;
      }

      const response = await axios.get<StacksBalance>(
        `${config.STACKS_API_URL}/extended/v1/address/${address}/balances`,
        { headers }
      );

      const data = response.data;

      const registry = DEXRegistry.getInstance();
      const stxPrice = await registry.getTokenPrice("STX");

      const stxBalance =
        parseInt(data.stx.balance, 10) / 1_000_000;
      balances.push({
        token: "STX",
        symbol: "STX",
        balance: stxBalance,
        usdValue: stxBalance * (stxPrice || 2.0),
      });

      const tokenMap = new Map(
        swappableTokens.map((t) => [t.contractId, t])
      );

      const allowedTokens = ConfigManager.getInstance().allowedTokens;
      const blockedTokens = ConfigManager.getInstance().blockedTokens;

      for (const [contractId, tokenData] of Object.entries(
        data.fungible_tokens ?? {}
      )) {
        const token = tokenMap.get(contractId);
        if (!token) continue;

        if (allowedTokens.length > 0 && !allowedTokens.includes(contractId)) {
          continue;
        }
        if (blockedTokens.length > 0 && blockedTokens.includes(contractId)) {
          continue;
        }
        if (userBlockedSet.has(contractId)) {
          continue;
        }

        const rawBalance = parseInt(tokenData.balance, 10);
        const balance = rawBalance / 10 ** token.decimals;

        if (balance <= 0) continue;

        const tokenPrice = await registry.getTokenPrice(token.symbol);
        const usdValue = balance * (tokenPrice || 1.0);

        if (usdValue < this.dustThresholdUsd) continue;

        balances.push({
          token: token.contractId,
          symbol: token.symbol,
          balance,
          usdValue,
        });
      }
    } catch (error) {
      logger.error("Failed to fetch balances", { address, error });
      throw error;
    }

    return balances;
  }

  computeRebalanceActions(
    currentBalances: TokenBalance[],
    targets: PortfolioTarget[],
    rebalanceThreshold: number
  ): RebalanceAction[] {
    const actions = runRebalance(currentBalances, targets, rebalanceThreshold);

    const totalValue = currentBalances.reduce((sum, b) => sum + b.usdValue, 0);
    logger.info("Rebalance actions computed", {
      totalValue: totalValue.toFixed(2),
      actionCount: actions.length,
    });

    return actions;
  }
}

export function runRebalance(
  currentBalances: TokenBalance[],
  targets: PortfolioTarget[],
  rebalanceThreshold: number
): RebalanceAction[] {
  const actions: RebalanceAction[] = [];
  const totalValue = currentBalances.reduce((sum, b) => sum + b.usdValue, 0);

  if (totalValue <= 0) return actions;

  const currentWeights = new Map<string, number>();
  for (const b of currentBalances) {
    currentWeights.set(b.symbol, b.usdValue / totalValue);
  }

  for (const target of targets) {
    const currentWeight = currentWeights.get(target.token) ?? 0;
    const deviation = target.targetWeight - currentWeight;
    const absDeviation = Math.abs(deviation);

    if (absDeviation < rebalanceThreshold / 100) continue;

    if (deviation > 0) {
      const targetValue = target.targetWeight * totalValue;
      const currentValue = currentWeight * totalValue;
      const buyAmount = targetValue - currentValue;

      const stxBalance = currentBalances.find((b) => b.symbol === "STX");
      const stxValue = stxBalance?.usdValue ?? 0;

      if (stxValue < buyAmount) continue;

      const stxPrice =
        stxBalance && stxBalance.balance > 0
          ? stxBalance.usdValue / stxBalance.balance
          : 2.0;
      const stxToSpend = buyAmount / stxPrice;

      actions.push({
        tokenIn: "STX",
        tokenOut: target.token,
        amountIn: stxToSpend,
        direction: "BUY",
        reason: `Underweight ${target.token} by ${(absDeviation * 100).toFixed(1)}%`,
      });
    } else {
      const currentValue = currentWeight * totalValue;
      const targetValue = target.targetWeight * totalValue;
      const sellAmount = currentValue - targetValue;

      if (target.token === "STX") continue;

      const tokenBalance = currentBalances.find(
        (b) => b.symbol === target.token
      );
      if (!tokenBalance || tokenBalance.balance <= 0) continue;

      const sellUnits =
        sellAmount / (tokenBalance.usdValue / tokenBalance.balance);

      actions.push({
        tokenIn: target.token,
        tokenOut: "STX",
        amountIn: Math.min(sellUnits, tokenBalance.balance),
        direction: "SELL",
        reason: `Overweight ${target.token} by ${(absDeviation * 100).toFixed(1)}%`,
      });
    }
  }

  actions.sort((a, b) => Math.abs(b.amountIn) - Math.abs(a.amountIn));

  return actions;
}
