import { describe, it, expect, beforeEach, vi } from "vitest";
import { BitflowDEXService } from "../src/services/dex/bitflow.js";

describe("BitflowDEXService Token Resolution and Matching", () => {
  let bitflowService: BitflowDEXService;

  beforeEach(() => {
    // Reset singleton instance or instantiate if not done
    try {
      BitflowDEXService.initialize();
    } catch {
      // Ignored if already initialized
    }
    bitflowService = BitflowDEXService.getInstance();
  });

  describe("matchesToken", () => {
    it("should match STX correctly with various STX aliases", () => {
      // Accessing private method matchesToken
      const matchesToken = (bitflowService as any).matchesToken.bind(bitflowService);

      // Matches STX to STX
      expect(matchesToken("null", "STX", "STX")).toBe(true);
      // Matches wstx contract to STX
      expect(matchesToken("SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx", "STX", "STX")).toBe(true);
      // Matches standard wstx contract as target
      expect(matchesToken("null", "STX", "SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx")).toBe(true);
      expect(matchesToken("SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx", "STX", "SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx")).toBe(true);
      // Matches token-stx as target
      expect(matchesToken("null", "STX", "token-stx")).toBe(true);
    });

    it("should match regular tokens correctly by symbol and contract", () => {
      const matchesToken = (bitflowService as any).matchesToken.bind(bitflowService);

      expect(matchesToken("SP2XD7417HGPRTREMKF748VNEQPDRR0RMANB7X1NK.token-susdt", "sUSDT", "sUSDT")).toBe(true);
      expect(matchesToken("SP2XD7417HGPRTREMKF748VNEQPDRR0RMANB7X1NK.token-susdt", "sUSDT", "SP2XD7417HGPRTREMKF748VNEQPDRR0RMANB7X1NK.token-susdt")).toBe(true);
      expect(matchesToken("SP2XD7417HGPRTREMKF748VNEQPDRR0RMANB7X1NK.token-susdt", "sUSDT", "token-susdt")).toBe(true);
    });
  });

  describe("resolveTokenId", () => {
    it("should resolve any STX contract or symbol to token-stx directly", () => {
      const resolveTokenId = (bitflowService as any).resolveTokenId.bind(bitflowService);

      expect(resolveTokenId("STX")).toBe("token-stx");
      expect(resolveTokenId("wstx")).toBe("token-stx");
      expect(resolveTokenId("SP1Y5YSTAHZ88XYK1VPDH24GY0HPX5J4JECTMY4A1.wstx")).toBe("token-stx");
      expect(resolveTokenId("token-stx")).toBe("token-stx");
    });

    it("should resolve pool tokens correctly", () => {
      const resolveTokenId = (bitflowService as any).resolveTokenId.bind(bitflowService);

      // Seed a mock pool
      (bitflowService as any).pools = [
        {
          tokenXId: "token-susdt",
          tokenYId: "token-stx",
          tokenXSymbol: "sUSDT",
          tokenYSymbol: "STX",
          tokenXContract: "SP2XD7417HGPRTREMKF748VNEQPDRR0RMANB7X1NK.token-susdt",
          tokenYContract: "null",
          decimals: 8,
          feeRate: 30
        }
      ];

      expect(resolveTokenId("SP2XD7417HGPRTREMKF748VNEQPDRR0RMANB7X1NK.token-susdt")).toBe("token-susdt");
      expect(resolveTokenId("sUSDT")).toBe("token-susdt");
    });
  });
});
