import { z } from "zod";
import type { SafeParseReturnType } from "zod";

const positiveNumber = z.coerce.number().finite().positive();
const nonNegativeNumber = z.coerce.number().finite().nonnegative();
const percentage = z.coerce.number().finite().min(0).max(100);
const positiveInt = z.coerce.number().int().positive();
const boundedSlippageBps = z.coerce.number().int().min(1).max(10_000);
const token = z.string().trim().min(1).max(128);
const tokenPair = z.string().trim().regex(/^[^/\s]+\/[^/\s]+$/, "Expected TOKEN/TOKEN pair");
const csv = z.string().max(2_000).default("");

const baseSchema = z.object({
  walletIds: z.array(z.number().int().positive()).optional(),
}).passthrough();

const schemas: Record<string, z.ZodObject<any>> = {
  portfolio_rebalance: baseSchema.extend({
    rebalanceThreshold: percentage.default(2),
    maxPositionPct: percentage.default(25),
    useAI: z.coerce.boolean().default(true),
    aiRefreshMinutes: positiveInt.max(24 * 60).default(15),
    maxSlippageBps: boundedSlippageBps.default(100),
    tokenUniverse: csv,
    minTradeUsd: positiveNumber.max(1_000_000).default(5),
  }),
  grid: baseSchema.extend({
    tokenPair: tokenPair.default("STX/sUSDT"),
    levels: positiveInt.min(3).max(50).default(5),
    spreadBps: boundedSlippageBps.default(30),
    maxPositionPct: percentage.default(25),
    useAI: z.coerce.boolean().default(true),
    aiRefreshMinutes: positiveInt.max(24 * 60).default(30),
    gridRangePct: positiveNumber.max(100).default(5),
    totalCapitalUsd: positiveNumber.max(1_000_000).default(50),
  }),
  dca: baseSchema.extend({
    tokenIn: token.default("STX"),
    tokenOut: token.default("sUSDT"),
    amount: positiveNumber.max(1_000_000).default(1),
    intervalMinutes: positiveInt.max(365 * 24 * 60).default(60),
    priceCondition: z.enum(["always", "below", "above"]).default("always"),
    priceThresholdUsd: nonNegativeNumber.max(1_000_000_000).default(0),
    maxSlippageBps: boundedSlippageBps.default(100),
    totalBudgetUsd: nonNegativeNumber.max(1_000_000_000).default(0),
    endDate: z.string().datetime().optional(),
  }),
  sniper: baseSchema.extend({
    watchTokens: csv,
    maxBuyAmount: positiveNumber.max(1_000_000).default(1),
    perTokenCapUsd: positiveNumber.max(1_000_000).default(5),
    maxPriceImpactPct: positiveNumber.max(100).default(5),
    slippageBps: boundedSlippageBps.default(100),
    cooldownMinutes: nonNegativeNumber.max(365 * 24 * 60).default(60),
  }),
  copy: baseSchema.extend({
    targetAddress: z.string().trim().max(128).default(""),
    maxPerTrade: positiveNumber.max(1_000_000).default(10),
    maxCopiesPerCycle: positiveInt.max(100).default(3),
    copyRatio: positiveNumber.max(100).default(1),
    delaySeconds: nonNegativeNumber.max(86_400).default(0),
  }),
  momentum: baseSchema.extend({
    lookbackPeriods: positiveInt.max(10_000).default(20),
    momentumThresholdPct: z.coerce.number().finite().min(-100).max(10_000).default(2),
    exitThresholdPct: z.coerce.number().finite().min(-100).max(10_000).default(-1),
    positionSizeUsd: positiveNumber.max(1_000_000).default(10),
    tokenUniverse: csv,
  }),
  mean_reversion: baseSchema.extend({
    maPeriods: positiveInt.max(10_000).default(20),
    entryDeviationPct: positiveNumber.max(10_000).default(5),
    exitDeviationPct: nonNegativeNumber.max(10_000).default(1),
    tokenPair: tokenPair.default("STX/sUSDT"),
    positionSizeUsd: positiveNumber.max(1_000_000).default(10),
  }),
  twap: baseSchema.extend({
    tokenIn: token.default("STX"),
    tokenOut: token.default("sUSDT"),
    totalAmount: positiveNumber.max(1_000_000).default(10),
    slices: positiveInt.max(1_000).default(10),
    windowMinutes: positiveInt.max(365 * 24 * 60).default(60),
    maxSlippageBps: boundedSlippageBps.default(100),
  }),
  stop_loss_tp: baseSchema.extend({
    token: token.or(z.literal("")).default(""),
    takeProfitPct: positiveNumber.max(10_000).default(10),
    stopLossPct: positiveNumber.max(100).default(5),
    trailingStopPct: nonNegativeNumber.max(100).default(0),
  }),
  rotational: baseSchema.extend({
    topK: positiveInt.max(100).default(3),
    rebalancePeriodHours: positiveNumber.max(365 * 24).default(24),
    positionSizeUsd: positiveNumber.max(1_000_000).default(10),
    tokenUniverse: csv,
  }),
  breakout: baseSchema.extend({
    lookbackPeriods: positiveInt.max(10_000).default(20),
    breakoutPct: positiveNumber.max(10_000).default(3),
    tokenPair: tokenPair.default("STX/sUSDT"),
    positionSizeUsd: positiveNumber.max(1_000_000).default(10),
  }),
};

export function validateStrategyConfig(type: string, config: Record<string, unknown>): Record<string, unknown> {
  const schema = schemas[type];
  if (!schema) {
    throw new Error(`Unsupported strategy type: ${type}`);
  }
  return schema.parse(config);
}

export function safeValidateStrategyConfig(type: string, config: Record<string, unknown>): SafeParseReturnType<Record<string, unknown>, Record<string, unknown>> {
  const schema = schemas[type];
  if (!schema) {
    return {
      success: false,
      error: new z.ZodError([
        {
          code: z.ZodIssueCode.custom,
          path: ["type"],
          message: `Unsupported strategy type: ${type}`,
        },
      ]),
    };
  }
  return schema.safeParse(config) as SafeParseReturnType<Record<string, unknown>, Record<string, unknown>>;
}
