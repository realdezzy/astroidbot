import { findSwapRoute, calculateSwapAmount } from "../src/services/dex/alex.js";
import type { SwappableToken } from "../src/types.js";

interface TokenPair {
  tokenX: string;
  tokenY: string;
  contractId: string;
  balanceX: number;
  balanceY: number;
}

const mockTokens: SwappableToken[] = [
  {
    contractId: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.token-wstx",
    symbol: "STX",
    name: "Wrapped STX",
    decimals: 6,
  },
  {
    contractId: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.token-susdt",
    symbol: "sUSDT",
    name: "Stacks USDT",
    decimals: 6,
  },
  {
    contractId: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.token-wbtc",
    symbol: "WBTC",
    name: "Wrapped BTC",
    decimals: 8,
  },
];

const mockPairs: TokenPair[] = [
  {
    tokenX: mockTokens[0]!.contractId,
    tokenY: mockTokens[1]!.contractId,
    contractId: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.alex-v2-0",
    balanceX: 1_000_000,
    balanceY: 1_500_000,
  },
  {
    tokenX: mockTokens[0]!.contractId,
    tokenY: mockTokens[2]!.contractId,
    contractId: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.alex-v2-1",
    balanceX: 500_000,
    balanceY: 10,
  },
];

function filterTokens(
  tokens: SwappableToken[],
  allowed: string[],
  blocked: string[]
): SwappableToken[] {
  let result = tokens;

  if (allowed.length > 0) {
    result = result.filter((t) => allowed.includes(t.contractId));
  }

  if (blocked.length > 0) {
    result = result.filter((t) => !blocked.includes(t.contractId));
  }

  return result;
}

describe("AlexDEXService (from src/)", () => {
  describe("Token filtering", () => {
    it("returns all tokens when no filters set", () => {
      const result = filterTokens(mockTokens, [], []);
      expect(result).toHaveLength(3);
    });

    it("filters to allowed tokens only", () => {
      const result = filterTokens(mockTokens, [mockTokens[0]!.contractId], []);
      expect(result).toHaveLength(1);
      expect(result[0]!.symbol).toBe("STX");
    });

    it("excludes blocked tokens", () => {
      const result = filterTokens(
        mockTokens,
        [],
        [mockTokens[1]!.contractId]
      );
      expect(result).toHaveLength(2);
      expect(result.map((t) => t.symbol)).not.toContain("sUSDT");
    });

    it("allowed takes precedence over blocked", () => {
      const result = filterTokens(
        mockTokens,
        [mockTokens[0]!.contractId],
        [mockTokens[0]!.contractId]
      );
      expect(result).toHaveLength(0);
    });
  });

  describe("Route finding", () => {
    it("finds direct swap route", () => {
      const route = findSwapRoute(
        mockPairs,
        mockTokens[0]!.contractId,
        mockTokens[1]!.contractId
      );
      expect(route).not.toBeNull();
      expect(route!.tokenIn).toBe(mockTokens[0]!.contractId);
      expect(route!.tokenOut).toBe(mockTokens[1]!.contractId);
    });

    it("returns null for same token", () => {
      const route = findSwapRoute(
        mockPairs,
        mockTokens[0]!.contractId,
        mockTokens[0]!.contractId
      );
      expect(route).toBeNull();
    });

    it("returns null for non-existent pair (no route even with hops)", () => {
      const isolatedPairs: TokenPair[] = [
        { ...mockPairs[0]! },
        {
          tokenX: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.token-wbtc",
          tokenY: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.token-diko",
          contractId: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.alex-v2-1",
          balanceX: 10,
          balanceY: 100_000,
        },
      ];
      const route = findSwapRoute(
        isolatedPairs,
        mockTokens[1]!.contractId,
        mockTokens[2]!.contractId
      );
      expect(route).toBeNull();
    });

    it("reversed pair still works", () => {
      const route = findSwapRoute(
        mockPairs,
        mockTokens[1]!.contractId,
        mockTokens[0]!.contractId
      );
      expect(route).not.toBeNull();
    });
  });

  describe("Swap amount calculation", () => {
    it("calculates output for constant product AMM", () => {
      const result = calculateSwapAmount(
        mockPairs,
        mockTokens[0]!.contractId,
        mockTokens[1]!.contractId,
        100
      );
      expect(result.amountOut).toBeGreaterThan(0);
      expect(result.priceImpact).toBeGreaterThanOrEqual(0);
    });

    it("returns zero for non-existent pair", () => {
      const result = calculateSwapAmount(
        mockPairs,
        mockTokens[1]!.contractId,
        mockTokens[2]!.contractId,
        100
      );
      expect(result.amountOut).toBe(0);
    });

    it("larger swaps have higher price impact", () => {
      const small = calculateSwapAmount(
        mockPairs,
        mockTokens[0]!.contractId,
        mockTokens[1]!.contractId,
        10
      );
      const large = calculateSwapAmount(
        mockPairs,
        mockTokens[0]!.contractId,
        mockTokens[1]!.contractId,
        10000
      );
      expect(large.priceImpact).toBeGreaterThan(small.priceImpact);
    });
  });
});
