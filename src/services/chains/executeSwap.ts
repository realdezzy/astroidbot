import { TransactionService } from "../transaction.js";
import { ChainAdapterRegistry } from "./chainAdapterRegistry.js";
import { assertStacksPayload, assertSvmPayload } from "../../types.js";
import { logger } from "../../utils/logger.js";
import { DEFAULT_CHAIN_FOR_FAMILY, DEFAULT_CHAIN_ID } from "./descriptors/index.js";
import type { RebalanceAction, TransactionPayload } from "../../types.js";
import type { ChainId } from "../../types/chain.js";

/**
 * Resolves the ChainId a trade should execute on.
 *
 * `Wallet.chain` has held the concrete chainId since the column was added and
 * is authoritative. The `chainFamily` fallback exists only for rows and call
 * sites predating it, and resolves to the family's default network.
 *
 * Note what this deliberately does NOT do: silently substitute a default when
 * the wallet names a chain that isn't registered. Executing a Celo wallet's
 * trade on Base because Celo wasn't enabled would move real funds on the wrong
 * network — better to fail with the chain named.
 */
export function resolveChainId(params: {
  chainId?: string | null;
  chainFamily?: string | null;
}): ChainId {
  if (params.chainId) return params.chainId;
  if (params.chainFamily) {
    return DEFAULT_CHAIN_FOR_FAMILY[params.chainFamily] ?? params.chainFamily;
  }
  return DEFAULT_CHAIN_ID;
}

/**
 * Single dispatch point every trade-execution call site goes through instead of
 * calling TransactionService directly.
 *
 * Branches on the payload's kind (set by the DEXProvider that built it) so
 * Stacks call sites keep their exact existing behaviour while EVM payloads
 * route through the wallet's registered ChainAdapter. Centralised here rather
 * than duplicated across userController/strategyEngine/tradeWorker/limitOrder
 * so the shapes cannot drift between call sites — and so adding a chain family
 * is one new branch here rather than five.
 */
export async function executeSwapPayload(
  payload: TransactionPayload,
  params: {
    action: RebalanceAction;
    walletId: number;
    senderAddress: string;
    maxOutbound: number;
    useGasless?: boolean;
    /** Concrete network. Preferred over chainFamily. */
    chainId?: string;
    /** @deprecated Pass chainId — a family does not identify a network. */
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

      const chainId = resolveChainId(params);
      const registry = ChainAdapterRegistry.getInstance();
      if (!registry.has(chainId)) {
        return { error: `No chain adapter registered for "${chainId}"` };
      }
      const adapter = registry.get(chainId);
      if (!adapter.executeEvmCall) {
        return { error: `Chain "${chainId}" does not support EVM-style execution` };
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

    if (payload.kind === "svm") {
      assertSvmPayload(payload);

      const chainId = resolveChainId(params);
      const registry = ChainAdapterRegistry.getInstance();
      if (!registry.has(chainId)) {
        return { error: `No chain adapter registered for "${chainId}"` };
      }
      const adapter = registry.get(chainId);
      if (!adapter.executeSvmCall) {
        return { error: `Chain "${chainId}" does not support Solana-style execution` };
      }

      return await adapter.executeSvmCall({
        transactionBase64: payload.swapTransaction,
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
      chainId: params.chainId ?? params.chainFamily,
      walletId: params.walletId,
    });
    return { error: message };
  }
}

/**
 * Confirmation dispatch counterpart — a trade's wallet decides which adapter's
 * confirmTransaction to poll.
 */
export async function confirmSwap(
  txId: string,
  tradeId: number,
  chainScope: string,
  poll = false
): Promise<"confirmed" | "failed" | "pending"> {
  const chainId = chainScope.includes(":")
    ? chainScope
    : resolveChainId({ chainFamily: chainScope });

  const registry = ChainAdapterRegistry.getInstance();

  if (!registry.has(chainId)) {
    // Stacks predates the registry and can always fall back to
    // TransactionService directly, so a Stacks trade is never stranded.
    if (chainId.startsWith("stacks:")) {
      return TransactionService.getInstance().confirmTransaction(txId, tradeId, poll);
    }
    // Chain was disabled (e.g. removed from ENABLED_CHAINS) while a trade was
    // in flight. Reporting "pending" keeps the trade retryable once it is
    // re-enabled instead of marking a possibly-successful trade failed.
    logger.warn("Cannot confirm trade: no chain adapter registered", { chainId, tradeId, txId });
    return "pending";
  }

  return registry.get(chainId).confirmTransaction(txId, tradeId, poll);
}
