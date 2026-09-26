import { ConfigManager } from "../../config.js";
import { logger } from "../../utils/logger.js";

/**
 * Whether the quantitative layer is switched on.
 *
 * It is off by default, and the reason is not that the maths is wrong — it is
 * that the maths has no input. `FeatureEngine.compute` needs thirty 5-minute
 * candles and returns `emptyFeatures` below that: RSI 50, MACD 0, volatility
 * 0, every return 0. Those are not markers of absence, they are readings, and
 * downstream they are consumed as such — `signalFusion` scores EMA12 ≤ EMA26
 * as a bearish crossover when both are the same number, and the regime gate
 * classifies the result as a real regime and suppresses strategies on it.
 *
 * So the disabled state is explicit and distinguishable (`Features.available`)
 * rather than a zeroed feature set, and every consumer branches on it. What
 * keeps running is everything deterministic: DCA still buys on its schedule,
 * grid still places its ladder, stop-loss still fires on its configured
 * percentage. They simply stop consulting technical signals that were being
 * computed from nothing.
 *
 * Logged once, on first read, not per cycle: the strategy worker asks per
 * token per strategy per tick, and a per-call line would bury the log in the
 * report that nothing is happening.
 */
let announced = false;

export function isQuantEnabled(): boolean {
  const enabled = ConfigManager.getInstance().config.QUANT_ENABLED;

  if (!announced) {
    announced = true;
    if (enabled) {
      logger.info("[quant] technical features enabled");
    } else {
      logger.info("[quant] technical features disabled", {
        hint:
          "Regime gating, signal fusion and volatility sizing are inert; " +
          "deterministic strategies are unaffected. Set QUANT_ENABLED=true to restore them.",
      });
    }
  }

  return enabled;
}

/** Test seam: the "said it once" latch is module state and leaks between suites. */
export function resetQuantAnnouncement(): void {
  announced = false;
}
