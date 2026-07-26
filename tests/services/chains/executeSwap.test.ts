import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { ConfigManager } from "../../../src/config.js";

const mockTxService = {
  execute: vi.fn(),
  confirmTransaction: vi.fn(),
};

vi.mock("../../../src/services/transaction.js", () => ({
  TransactionService: { getInstance: () => mockTxService },
}));

const mockEvmAdapter = {
  chainFamily: "evm",
  executeEvmCall: vi.fn(),
  confirmTransaction: vi.fn(),
};

describe("executeSwap dispatch Unit Tests", () => {
  let executeSwapPayload: typeof import("../../../src/services/chains/executeSwap.js").executeSwapPayload;
  let confirmSwap: typeof import("../../../src/services/chains/executeSwap.js").confirmSwap;
  let ChainAdapterRegistry: typeof import("../../../src/services/chains/chainAdapterRegistry.js").ChainAdapterRegistry;

  const action = { tokenIn: "STX", tokenOut: "ALEX", amountIn: 10, direction: "BUY" as const, reason: "test" };

  beforeAll(async () => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
    if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;
    ConfigManager.load();
    ({ executeSwapPayload, confirmSwap } = await import("../../../src/services/chains/executeSwap.js"));
    ({ ChainAdapterRegistry } = await import("../../../src/services/chains/chainAdapterRegistry.js"));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // Re-register a fresh mock EVM adapter each test since the registry is a singleton.
    (ChainAdapterRegistry.getInstance() as any).adapters = new Map();
    ChainAdapterRegistry.getInstance().register(mockEvmAdapter as any);
  });

  it("dispatches a Stacks-kind payload (no `kind`) to TransactionService.execute", async () => {
    mockTxService.execute.mockResolvedValue({ txId: "0xstacks" });

    const result = await executeSwapPayload(
      {
        contractAddress: "SP1", contractName: "pool", functionName: "swap",
        functionArgs: [], postConditions: [],
      },
      { action, walletId: 1, senderAddress: "SP1ADDR", maxOutbound: 9.9 }
    );

    expect(result).toEqual({ txId: "0xstacks" });
    expect(mockTxService.execute).toHaveBeenCalledWith(
      action, "SP1", "pool", "swap", [], 1, "SP1ADDR", 9.9, false, []
    );
    expect(mockEvmAdapter.executeEvmCall).not.toHaveBeenCalled();
  });

  it("dispatches an evm-kind payload to the registered EVM adapter's executeEvmCall, converting value to bigint", async () => {
    mockEvmAdapter.executeEvmCall.mockResolvedValue({ txId: "0xevm" });

    const result = await executeSwapPayload(
      {
        kind: "evm",
        calls: [
          { to: "0xRouter", data: "0xapprove" },
          { to: "0xRouter", data: "0xswap", value: "1000000000000000000" },
        ],
      },
      { action, walletId: 2, senderAddress: "0xSafeAddr", maxOutbound: 9.9, chainFamily: "evm" }
    );

    expect(result).toEqual({ txId: "0xevm" });
    expect(mockEvmAdapter.executeEvmCall).toHaveBeenCalledWith({
      calls: [
        { to: "0xRouter", data: "0xapprove", value: undefined },
        { to: "0xRouter", data: "0xswap", value: 1000000000000000000n },
      ],
      walletId: 2,
      senderAddress: "0xSafeAddr",
    });
    expect(mockTxService.execute).not.toHaveBeenCalled();
  });

  it("returns an error for an evm-kind payload with no calls, without throwing", async () => {
    const result = await executeSwapPayload(
      { kind: "evm", calls: [] },
      { action, walletId: 2, senderAddress: "0xSafeAddr", maxOutbound: 9.9, chainFamily: "evm" }
    );
    expect(result).toEqual({ error: "EVM swap payload is missing calls" });
  });

  it("confirmSwap routes 'stacks' to TransactionService.confirmTransaction", async () => {
    mockTxService.confirmTransaction.mockResolvedValue("confirmed");
    const state = await confirmSwap("0xabc", 5, "stacks");
    expect(state).toBe("confirmed");
    expect(mockTxService.confirmTransaction).toHaveBeenCalledWith("0xabc", 5, false);
  });

  it("confirmSwap routes any other chainFamily to that adapter's confirmTransaction", async () => {
    mockEvmAdapter.confirmTransaction.mockResolvedValue("pending");
    const state = await confirmSwap("0xdef", 6, "evm");
    expect(state).toBe("pending");
    expect(mockEvmAdapter.confirmTransaction).toHaveBeenCalledWith("0xdef", 6, false);
    expect(mockTxService.confirmTransaction).not.toHaveBeenCalled();
  });
});
