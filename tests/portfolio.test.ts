import { runRebalance } from "../src/services/portfolio.js";
import type { TokenBalance, PortfolioTarget } from "../src/types.js";

export function filterByDust(
  balances: TokenBalance[],
  threshold: number
): TokenBalance[] {
  return balances.filter((b) => b.usdValue >= threshold);
}

export function validateMaxPosition(
  balance: TokenBalance,
  totalValue: number,
  maxPct: number
): boolean {
  const currentPct = (balance.usdValue / totalValue) * 100;
  return currentPct <= maxPct;
}

describe("PortfolioManager", () => {
  const baseBalances: TokenBalance[] = [
    { token: "STX", symbol: "STX", balance: 500, usdValue: 1000 },
    { token: "xUSD", symbol: "xUSD", balance: 500, usdValue: 500 },
    { token: "DIKO", symbol: "DIKO", balance: 100, usdValue: 500 },
  ];

  describe("Rebalance action calculation (from src/)", () => {
    it("returns no actions when portfolio matches targets exactly", () => {
      const targets: PortfolioTarget[] = [
        { token: "STX", targetWeight: 0.5 },
        { token: "xUSD", targetWeight: 0.25 },
        { token: "DIKO", targetWeight: 0.25 },
      ];
      const actions = runRebalance(baseBalances, targets, 2.0);
      expect(actions).toHaveLength(0);
    });

    it("generates BUY when token is underweight", () => {
      const targets: PortfolioTarget[] = [
        { token: "STX", targetWeight: 0.3 },
        { token: "xUSD", targetWeight: 0.6 },
        { token: "DIKO", targetWeight: 0.1 },
      ];
      const actions = runRebalance(baseBalances, targets, 2.0);
      const buys = actions.filter((a) => a.direction === "BUY");
      expect(buys.length).toBeGreaterThan(0);
    });

    it("generates SELL when token is overweight", () => {
      const targets: PortfolioTarget[] = [
        { token: "STX", targetWeight: 0.6 },
        { token: "xUSD", targetWeight: 0.1 },
        { token: "DIKO", targetWeight: 0.3 },
      ];
      const actions = runRebalance(baseBalances, targets, 2.0);
      const sells = actions.filter((a) => a.direction === "SELL");
      expect(sells.length).toBeGreaterThan(0);
    });

    it("respects rebalance threshold", () => {
      const targets: PortfolioTarget[] = [
        { token: "STX", targetWeight: 0.505 },
        { token: "xUSD", targetWeight: 0.245 },
        { token: "DIKO", targetWeight: 0.25 },
      ];
      const actionsLow = runRebalance(baseBalances, targets, 5.0);
      expect(actionsLow).toHaveLength(0);

      const actionsHigh = runRebalance(baseBalances, targets, 0.5);
      expect(actionsHigh.length).toBeGreaterThan(0);
    });

    it("skips STX sell actions (bug regression test)", () => {
      const targets: PortfolioTarget[] = [
        { token: "STX", targetWeight: 0.1 },
        { token: "xUSD", targetWeight: 0.45 },
        { token: "DIKO", targetWeight: 0.45 },
      ];
      const actions = runRebalance(baseBalances, targets, 1.0);
      const stxSells = actions.filter(
        (a) => a.tokenIn === "STX" && a.direction === "SELL"
      );
      expect(stxSells).toHaveLength(0);
    });

    it("still allows selling non-STX overweight tokens", () => {
      const balances: TokenBalance[] = [
        { token: "STX", symbol: "STX", balance: 100, usdValue: 200 },
        { token: "DIKO", symbol: "DIKO", balance: 100, usdValue: 800 },
      ];
      const targets: PortfolioTarget[] = [
        { token: "STX", targetWeight: 0.5 },
        { token: "DIKO", targetWeight: 0.5 },
      ];
      const actions = runRebalance(balances, targets, 1.0);
      const sells = actions.filter((a) => a.direction === "SELL");
      expect(sells.length).toBeGreaterThan(0);
      expect(sells[0]?.tokenIn).toBe("DIKO");
    });

    it("handles empty balances", () => {
      const actions = runRebalance(
        [],
        [{ token: "STX", targetWeight: 1.0 }],
        2.0
      );
      expect(actions).toHaveLength(0);
    });

    it("handles zero total value", () => {
      const zeroBalances: TokenBalance[] = [
        { token: "STX", symbol: "STX", balance: 0, usdValue: 0 },
      ];
      const actions = runRebalance(
        zeroBalances,
        [{ token: "STX", targetWeight: 1.0 }],
        2.0
      );
      expect(actions).toHaveLength(0);
    });
  });

  describe("Dust threshold filtering", () => {
    it("filters out balances below threshold", () => {
      const balances: TokenBalance[] = [
        { token: "STX", symbol: "STX", balance: 100, usdValue: 200 },
        { token: "A", symbol: "A", balance: 10, usdValue: 0.1 },
        { token: "B", symbol: "B", balance: 1, usdValue: 0.49 },
        { token: "C", symbol: "C", balance: 1, usdValue: 0.5 },
      ];
      const filtered = filterByDust(balances, 0.5);
      expect(filtered.map((b) => b.symbol)).toEqual(["STX", "C"]);
    });

    it("keeps all balances when threshold is 0", () => {
      const balances: TokenBalance[] = [
        { token: "A", symbol: "A", balance: 1, usdValue: 0.01 },
        { token: "B", symbol: "B", balance: 1, usdValue: 0.02 },
      ];
      expect(filterByDust(balances, 0)).toHaveLength(2);
    });
  });

  describe("Max position enforcement", () => {
    it("flags when position exceeds max allowed", () => {
      const balance: TokenBalance = {
        token: "DIKO",
        symbol: "DIKO",
        balance: 100,
        usdValue: 600,
      };
      const totalValue = 1000;
      expect(validateMaxPosition(balance, totalValue, 25.0)).toBe(false);
    });

    it("allows position within limit", () => {
      const balance: TokenBalance = {
        token: "DIKO",
        symbol: "DIKO",
        balance: 10,
        usdValue: 200,
      };
      const totalValue = 1000;
      expect(validateMaxPosition(balance, totalValue, 25.0)).toBe(true);
    });
  });
});
