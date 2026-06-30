import { MarketMakerService } from "../marketMaker.js";
import type { RebalanceAction } from "../../types.js";
import type { Strategy, StrategyContext, StrategyState } from "./types.js";

export class GridStrategy implements Strategy {
  async execute(ctx: StrategyContext, _state: StrategyState): Promise<RebalanceAction[]> {
    const { userId, walletId, balances, config, settings } = ctx;
    const mm = MarketMakerService.getInstance();
    const actions = await mm.tick(userId, walletId, balances);
    if (actions.length === 0) return [];
    void config;
    void settings;
    return actions;
  }
}
