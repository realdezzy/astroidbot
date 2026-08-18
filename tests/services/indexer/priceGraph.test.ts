import { describe, expect, it } from "vitest";
import { PriceGraph } from "../../../src/services/indexer/pricing/priceGraph.js";
import { ConfidenceScorer } from "../../../src/services/indexer/pricing/confidenceScorer.js";

describe("PriceGraph", () => {
  it("computes multi-hop path pricing accurately across liquidity pools", () => {
    const graph = new PriceGraph();

    // TokenA -> TokenB at 10, liquidity $50k
    graph.addEdge({ fromToken: "tokenA", toToken: "tokenB", price: 10, liquidityUsd: 50000 });
    // TokenB -> USDC at 2, liquidity $100k
    graph.addEdge({ fromToken: "tokenB", toToken: "usdc", price: 2, liquidityUsd: 100000 });

    const path = graph.findPricePath("tokenA", "usdc");
    expect(path).not.toBeNull();
    expect(path?.price).toBe(20);
    expect(path?.hops).toBe(2);
    expect(path?.minLiquidityUsd).toBe(50000);
  });
});

describe("ConfidenceScorer", () => {
  it("rates deep high-liquidity 1-hop routes as high confidence", () => {
    const confidence = ConfidenceScorer.evaluateConfidence({
      hops: 1,
      liquidityUsd: 100000,
      txns24h: 150,
    });
    expect(confidence).toBe("high");
  });

  it("rates low liquidity or deep hop routes as low confidence", () => {
    const confidence = ConfidenceScorer.evaluateConfidence({
      hops: 4,
      liquidityUsd: 500,
    });
    expect(confidence).toBe("low");
  });
});
