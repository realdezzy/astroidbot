export interface PriceEdge {
  fromToken: string;
  toToken: string;
  price: number;
  liquidityUsd: number;
}

export class PriceGraph {
  private adjacencyList = new Map<string, PriceEdge[]>();

  addEdge(edge: PriceEdge): void {
    const from = edge.fromToken.toLowerCase();
    const to = edge.toToken.toLowerCase();

    if (!this.adjacencyList.has(from)) {
      this.adjacencyList.set(from, []);
    }
    this.adjacencyList.get(from)!.push({ ...edge, fromToken: from, toToken: to });

    if (edge.price > 0) {
      if (!this.adjacencyList.has(to)) {
        this.adjacencyList.set(to, []);
      }
      this.adjacencyList.get(to)!.push({
        fromToken: to,
        toToken: from,
        price: 1 / edge.price,
        liquidityUsd: edge.liquidityUsd,
      });
    }
  }

  findPricePath(
    startToken: string,
    targetToken: string,
    maxHops = 3
  ): { price: number; hops: number; minLiquidityUsd: number } | null {
    const start = startToken.toLowerCase();
    const target = targetToken.toLowerCase();

    if (start === target) {
      return { price: 1, hops: 0, minLiquidityUsd: Infinity };
    }

    const queue: { token: string; currentPrice: number; hops: number; minLiquidity: number; visited: Set<string> }[] = [
      { token: start, currentPrice: 1, hops: 0, minLiquidity: Infinity, visited: new Set([start]) },
    ];

    let bestResult: { price: number; hops: number; minLiquidityUsd: number } | null = null;

    while (queue.length > 0) {
      const current = queue.shift()!;

      if (current.hops >= maxHops) continue;

      const edges = this.adjacencyList.get(current.token) ?? [];
      for (const edge of edges) {
        if (current.visited.has(edge.toToken)) continue;

        const nextPrice = current.currentPrice * edge.price;
        const nextMinLiquidity = Math.min(current.minLiquidity, edge.liquidityUsd);
        const newVisited = new Set(current.visited);
        newVisited.add(edge.toToken);

        if (edge.toToken === target) {
          if (!bestResult || nextMinLiquidity > bestResult.minLiquidityUsd) {
            bestResult = {
              price: nextPrice,
              hops: current.hops + 1,
              minLiquidityUsd: nextMinLiquidity,
            };
          }
        } else {
          queue.push({
            token: edge.toToken,
            currentPrice: nextPrice,
            hops: current.hops + 1,
            minLiquidity: nextMinLiquidity,
            visited: newVisited,
          });
        }
      }
    }

    return bestResult;
  }

  clear(): void {
    this.adjacencyList.clear();
  }
}
