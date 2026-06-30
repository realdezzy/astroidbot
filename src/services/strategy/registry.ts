import { PortfolioRebalanceStrategy } from "./portfolioRebalance.js";
import { GridStrategy } from "./grid.js";
import { DCAStrategy } from "./dca.js";
import { SniperStrategy } from "./sniper.js";
import { CopyStrategy } from "./copy.js";
import { MomentumStrategy } from "./momentum.js";
import { MeanReversionStrategy } from "./meanReversion.js";
import { TwapStrategy } from "./twap.js";
import { StopLossTpStrategy } from "./stopLossTp.js";
import { RotationalStrategy } from "./rotational.js";
import { BreakoutStrategy } from "./breakout.js";
import type { Strategy } from "./types.js";

// Add new strategy types here — no changes needed elsewhere.
export const STRATEGY_REGISTRY: Record<string, new () => Strategy> = {
  portfolio_rebalance: PortfolioRebalanceStrategy,
  grid: GridStrategy,
  dca: DCAStrategy,
  sniper: SniperStrategy,
  copy: CopyStrategy,
  momentum: MomentumStrategy,
  mean_reversion: MeanReversionStrategy,
  twap: TwapStrategy,
  stop_loss_tp: StopLossTpStrategy,
  rotational: RotationalStrategy,
  breakout: BreakoutStrategy,
};
