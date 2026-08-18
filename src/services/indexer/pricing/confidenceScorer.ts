export type PriceConfidence = "high" | "medium" | "low";

export interface ConfidenceInput {
  hops: number;
  liquidityUsd: number;
  txns24h?: number;
}

export class ConfidenceScorer {
  static evaluateConfidence(input: ConfidenceInput): PriceConfidence {
    if (input.liquidityUsd < 1000 || input.hops > 3) {
      return "low";
    }

    if (input.liquidityUsd >= 50000 && input.hops <= 2) {
      return "high";
    }

    if (input.liquidityUsd >= 10000 && input.hops <= 2) {
      return "medium";
    }

    return "low";
  }
}
