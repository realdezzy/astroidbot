import { logger } from "../utils/logger.js";
import { LimitOrderService } from "../services/limitOrder.js";
import type { SwappableToken } from "../types.js";


interface WalletRef {
  id: number;
  userId: number;
  address: string;
}

export async function executeLimitOrderCycle(
  wallets: WalletRef[],
  tokens: SwappableToken[]
): Promise<{ executed: number }> {
  try {
    const service = LimitOrderService.getInstance();
    const result = await service.checkAndExecute(wallets, tokens);
    return { executed: result.executed };
  } catch (err) {
    logger.error("Limit order cycle failed", { error: err });
    return { executed: 0 };
  }
}
