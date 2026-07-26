import { TransactionService } from "../transaction.js";
import { ChainAdapterRegistry } from "./chainAdapterRegistry.js";
import { assertStacksPayload } from "../../types.js";
import { logger } from "../../utils/logger.js";
import type { RebalanceAction, TransactionPayload } from "../../types.js";

// Single dispatch point every trade-execution call site should go through
// instead of calling TransactionService directly — branches on the payload's
// kind (set by the DEXProvider that built it) so Stacks call sites keep their
// exact existing behavior while EVM payloads route through the wallet's
// registered ChainAdapter. Centralized here rather than duplicated across
// userController/strategyEngine/tradeWorker/limitOrder so the two shapes
// can't drift out of sync between call sites.
export async function executeSwapPayload(
  payload: TransactionPayload,
  params: {
    action: RebalanceAction;
    walletId: number;
    senderAddress: string;
    maxOutbound: number;
    useGasless?: boolean;
    chainFamily?: string;
  }
): Promise<{ txId: string } | { error: string }> {
  // Callers (tradeWorker, limitOrder, strategyEngine, userController) all branch
  // on `"txId" in result` and record a FAILED trade from the error string, so
  // dispatch problems are returned rather than thrown — an unregistered adapter
  // or a malformed payload would otherwise escape as an exception and take the
  // BullMQ retry path instead of being recorded against the trade.
  try {
    if (payload.kind === "evm") {
      if (!payload.calls || payload.calls.length === 0) {
        return { error: "EVM swap payload is missing calls" };
      }

      const chainFamily = params.chainFamily ?? "evm";
      const registry = ChainAdapterRegistry.getInstance();
      if (!registry.has(chainFamily)) {
        return { error: `No chain adapter registered for chainFamily "${chainFamily}"` };
      }
      const adapter = registry.get(chainFamily);
      if (!adapter.executeEvmCall) {
        return { error: `Chain adapter "${chainFamily}" does not support EVM-style execution` };
      }

      return await adapter.executeEvmCall({
        calls: payload.calls.map((c) => ({
          to: c.to,
          data: c.data,
          value: c.value ? BigInt(c.value) : undefined,
        })),
        walletId: params.walletId,
        senderAddress: params.senderAddress,
      });
    }

    assertStacksPayload(payload);
    return await TransactionService.getInstance().execute(
      params.action,
      payload.contractAddress,
      payload.contractName,
      payload.functionName,
      payload.functionArgs,
      params.walletId,
      params.senderAddress,
      params.maxOutbound,
      params.useGasless ?? false,
      payload.postConditions
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Swap dispatch failed", {
      error: message,
      kind: payload.kind ?? "stacks",
      chainFamily: params.chainFamily,
      walletId: params.walletId,
    });
    return { error: message };
  }
}

// Confirmation dispatch counterpart — a trade's wallet chainFamily decides
// which adapter's confirmTransaction to poll.
export async function confirmSwap(
  txId: string,
  tradeId: number,
  chainFamily: string,
  poll = false
): Promise<"confirmed" | "failed" | "pending"> {
  if (chainFamily === "stacks") {
    return TransactionService.getInstance().confirmTransaction(txId, tradeId, poll);
  }

  const registry = ChainAdapterRegistry.getInstance();
  if (!registry.has(chainFamily)) {
    // Chain was disabled (e.g. PIMLICO_API_KEY removed) while a trade was in
    // flight. Reporting "pending" keeps the trade retryable once it's
    // re-enabled instead of marking a possibly-successful trade failed.
    logger.warn("Cannot confirm trade: no chain adapter registered", { chainFamily, tradeId, txId });
    return "pending";
  }
  return registry.get(chainFamily).confirmTransaction(txId, tradeId, poll);
}
