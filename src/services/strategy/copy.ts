import axios from "axios";
import { ConfigManager } from "../../config.js";
import { DatabaseService } from "../db.js";
import type { RebalanceAction } from "../../types.js";
import type { Strategy, StrategyContext, StrategyState } from "./types.js";

export class CopyStrategy implements Strategy {
  async execute(ctx: StrategyContext, _state: StrategyState): Promise<RebalanceAction[]> {
    const { userId, walletId, config, settings, tokens } = ctx;
    const targetAddress = (config.targetAddress as string) ?? "";
    const maxPerTrade = (config.maxPerTrade as number) ?? 10;
    const maxCopies = (config.maxCopiesPerCycle as number) ?? 3;
    const copyRatio = (config.copyRatio as number) ?? 1;
    // Fix: delaySec is no longer used as a blocking sleep inside the strategy.
    // Delayed copy trades should be modelled as separate scheduled BullMQ jobs.

    if (!targetAddress) return [];

    try {
      const stacksApi = ConfigManager.getInstance().config.STACKS_API_URL;
      const txs = await axios.get(`${stacksApi}/extended/v1/address/${targetAddress}/transactions`, {
        params: { limit: 10 },
        timeout: 10_000,
      }).catch(() => ({ data: { results: [] } }));

      const results = (txs.data?.results ?? []) as Array<{
        tx_id: string; tx_type: string; tx_status: string; block_time: number;
        stx_transfers?: Array<{ amount: string; recipient: string }>;
        ft_transfers?: Array<{ amount: string; asset_identifier: string; recipient: string }>;
      }>;

      const db = DatabaseService.getInstance();
      const actions: RebalanceAction[] = [];

      for (const tx of results) {
        if (tx.tx_type !== "contract_call" || tx.tx_status !== "success") continue;
        const existing = await db.prisma.trade.findFirst({ where: { userId, walletId, txId: tx.tx_id } });
        if (existing) continue;
        const ageMs = Date.now() - (tx.block_time ?? 0) * 1000;
        if (ageMs > 3600_000) continue;

        let tokenIn = "STX";
        let tokenOut = "sUSDT";
        let amount = Math.min(maxPerTrade, 5);
        let direction: "BUY" | "SELL" = "BUY";

        const stxOut = (tx.stx_transfers ?? []).filter((t: any) => t.recipient !== targetAddress);
        if (stxOut.length > 0) {
          amount = Math.min(Number(stxOut[0]!.amount) / 1e6 * copyRatio, maxPerTrade);
          tokenIn = "STX";
          direction = "BUY";
        }

        const ftIn = (tx.ft_transfers ?? []).filter((t: any) => t.recipient === targetAddress);
        if (ftIn.length > 0) {
          const matched = tokens.find(tok => {
            const assetId = ((ftIn[0] as any)?.asset_identifier as string) ?? "";
            return tok.contractId.toLowerCase().includes((assetId.split("::")[0] ?? "").toLowerCase());
          });
          if (matched) { tokenOut = matched.symbol; direction = "BUY"; }
        }

        const ftOut = (tx.ft_transfers ?? []).filter((t: any) => t.recipient !== targetAddress);
        if (ftOut.length > 0) {
          const matched = tokens.find(tok => {
            const assetId = ((ftOut[0] as any)?.asset_identifier as string) ?? "";
            return tok.contractId.toLowerCase().includes((assetId.split("::")[0] ?? "").toLowerCase());
          });
          if (matched) {
            tokenIn = matched.symbol;
            direction = "SELL";
            amount = Math.min(Number(ftOut[0]!.amount) / 1e6 * copyRatio, maxPerTrade);
          }
        }

        actions.push({
          tokenIn, tokenOut, amountIn: amount, direction,
          reason: `Copy: ${targetAddress.slice(0, 8)}... tx ${tx.tx_id.slice(0, 8)}`,
        });
        if (actions.length >= maxCopies) break;
      }

      void settings;
      return actions;
    } catch {
      return [];
    }
  }
}
