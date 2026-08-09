import { MarketMakerService } from "../marketMaker.js";
import type { RebalanceAction } from "../../types.js";
import type { Strategy, StrategyContext, StrategyState } from "../../types/strategy.js";

export class GridStrategy implements Strategy {
  async execute(ctx: StrategyContext, _state: StrategyState): Promise<RebalanceAction[]> {
    const { userId, walletId, balances, config, settings, chainId } = ctx;
    const mm = MarketMakerService.getInstance();
    const actions = await mm.tick(userId, walletId, balances, chainId);
    if (actions.length === 0) return [];
    void config;
    void settings;
    return actions;
  }
}
