export type PoolLifecycleState = "DISCOVERED" | "ACTIVE" | "INACTIVE" | "DEAD";

export interface LifecycleEvaluationInput {
  liquidityUsd?: number | null;
  lastSwapAt?: Date | null;
  createdAt: Date;
}

export class PoolLifecycleEngine {
  static evaluateState(input: LifecycleEvaluationInput): PoolLifecycleState {
    const now = Date.now();
    const ageHours = (now - input.createdAt.getTime()) / (1000 * 60 * 60);

    if (!input.lastSwapAt) {
      if (ageHours > 72) return "DEAD";
      return "DISCOVERED";
    }

    const hoursSinceLastSwap = (now - input.lastSwapAt.getTime()) / (1000 * 60 * 60);

    if (hoursSinceLastSwap > 168) {
      // 7 days of inactivity
      return "DEAD";
    }

    if (hoursSinceLastSwap > 24 || (input.liquidityUsd != null && input.liquidityUsd < 100)) {
      return "INACTIVE";
    }

    return "ACTIVE";
  }
}
