import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { CopyStrategy } from "../../../src/services/strategy/copy.js";
import { DatabaseService } from "../../../src/services/db.js";
import axios from "axios";
import type { StrategyContext } from "../../../src/types/strategy.js";
import { ConfigManager } from "../../../src/config.js";

vi.mock("axios");

const mockFindFirst = vi.fn();
vi.mock("../../../src/services/db.js", () => {
  return {
    DatabaseService: {
      getInstance: () => ({
        prisma: {
          trade: {
            findFirst: mockFindFirst,
          },
        },
      }),
    },
  };
});

describe("CopyStrategy", () => {
  beforeAll(() => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") {
      delete process.env.TELEGRAM_WEBHOOK_URL;
    }
    if (process.env.VELUMX_RELAYER_URL === "") {
      delete process.env.VELUMX_RELAYER_URL;
    }
    ConfigManager.load();
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  const strategy = new CopyStrategy();

  const mockCtx: StrategyContext = {
    strategyId: 1,
    userId: 10,
    walletId: 2,
    address: "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE",
    balances: [],
    tokens: [
      { contractId: "SP2D5B2763078GD93F62CABC0000000000000000.alex", symbol: "ALEX", name: "alex", decimals: 8 },
    ],
    settings: {
      slippageBps: 100,
      maxPositionPct: 25,
      dailyLossLimit: 10,
      rebalanceThreshold: 2,
    },
    config: {
      targetAddress: "SPTargetAddressHere",
      maxPerTrade: 20,
      maxCopiesPerCycle: 2,
      copyRatio: 0.5,
      maxAgeHours: 1,
    },
  };

  beforeEach(() => {
    vi.resetAllMocks();
    mockFindFirst.mockResolvedValue(null);
  });

  it("should trigger copy BUY action when target address makes contract call swap", async () => {
    const mockTx = {
      tx_id: "txid123",
      tx_type: "contract_call",
      tx_status: "success",
      contract_call: {
        contract_id: "SP3K8A0K2S588K147CADDX9759389G5P4NQF258HM.swap-helper-v1",
        function_name: "swap-helper",
      },
      block_time: Math.floor(Date.now() / 1000) - 100, // 100 seconds ago
      stx_transfers: [
        { amount: "10000000", sender: "SPTargetAddressHere", recipient: "someone-else" }, // 10 STX
      ],
      ft_transfers: [
        { amount: "50000000", asset_identifier: "SP2D5B2763078GD93F62CABC0000000000000000.alex::alex", sender: "someone-else", recipient: "SPTargetAddressHere" },
      ],
    };

    vi.mocked(axios.get).mockResolvedValue({
      data: {
        results: [mockTx],
      },
    });

    const actions = await strategy.execute(mockCtx, {});
    expect(actions).toHaveLength(1);
    expect(actions[0]).toEqual({
      tokenIn: "STX",
      tokenOut: "ALEX",
      amountIn: 5, // 10 STX * copyRatio (0.5) = 5
      direction: "BUY",
      slippageBps: 100,
      reason: "Copy: SPTarget... tx txid123",
    });
  });

  it("should ignore transactions older than maxAgeHours", async () => {
    const mockTx = {
      tx_id: "txid_old",
      tx_type: "contract_call",
      tx_status: "success",
      contract_call: {
        contract_id: "SP3K8A0K2S588K147CADDX9759389G5P4NQF258HM.swap-helper-v1",
        function_name: "swap-helper",
      },
      block_time: Math.floor(Date.now() / 1000) - 7200, // 2 hours ago
      stx_transfers: [
        { amount: "10000000", sender: "SPTargetAddressHere", recipient: "someone-else" },
      ],
      ft_transfers: [
        { amount: "50000000", asset_identifier: "SP2D5B2763078GD93F62CABC0000000000000000.alex::alex", sender: "someone-else", recipient: "SPTargetAddressHere" },
      ],
    };

    vi.mocked(axios.get).mockResolvedValue({
      data: {
        results: [mockTx],
      },
    });

    const actions = await strategy.execute(mockCtx, {});
    expect(actions).toHaveLength(0);
  });
});
