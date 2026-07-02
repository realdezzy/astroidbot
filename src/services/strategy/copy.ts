import axios from "axios";
import { ConfigManager } from "../../config.js";
import { DatabaseService } from "../db.js";
import type { RebalanceAction } from "../../types.js";
import type { Strategy, StrategyContext, StrategyState } from "../../types/strategy.js";

// Known DEX contract addresses/deployers on Stacks Mainnet/Testnet to focus only on trade actions
const KNOWN_DEX_DEPLOYERS = [
  "SP3K8A0K2S588K147CADDX9759389G5P4NQF258HM", // ALEX
  "SP1Y5YST0XPA4HCJJJ685ADK5A53540JVEV6XW1HY", // Velar
  "SP102V8Y0F5F69YP96HC61A62MG17B1B6FD6EGQN6", // Bitflow
  "SP2C1WZHVDQ6GA3M1S0PAE156D240D2NXYN2Q4XDE", // Faktory
];

export class CopyStrategy implements Strategy {
  async execute(ctx: StrategyContext, _state: StrategyState): Promise<RebalanceAction[]> {
    const { userId, walletId, config, settings, tokens } = ctx;
    const targetAddress = (config.targetAddress as string) ?? "";
    const maxPerTrade = (config.maxPerTrade as number) ?? 10;
    const maxCopies = (config.maxCopiesPerCycle as number) ?? 3;
    const copyRatio = (config.copyRatio as number) ?? 1;
    const maxAgeHours = (config.maxAgeHours as number) ?? 4; // Configurable age gate
    const slippageBps = (config.slippageBps as number) ?? settings.slippageBps;

    if (!targetAddress) return [];

    try {
      const stacksApi = ConfigManager.getInstance().config.STACKS_API_URL;
      const txs = await axios.get(`${stacksApi}/extended/v1/address/${targetAddress}/transactions`, {
        params: { limit: 10 },
        timeout: 10_000,
      }).catch(() => ({ data: { results: [] } }));

      const results = (txs.data?.results ?? []) as Array<{
        tx_id: string;
        tx_type: string;
        tx_status: string;
        block_time: number;
        contract_call?: { contract_id: string; function_name: string };
        stx_transfers?: Array<{ amount: string; sender: string; recipient: string }>;
        ft_transfers?: Array<{ amount: string; asset_identifier: string; sender: string; recipient: string }>;
      }>;

      const db = DatabaseService.getInstance();
      const actions: RebalanceAction[] = [];

      for (const tx of results) {
        if (tx.tx_status !== "success") continue;

        // Verify if it's a contract call to a known DEX
        if (tx.tx_type === "contract_call" && tx.contract_call) {
          const deployer = tx.contract_call.contract_id.split(".")[0];
          if (deployer && !KNOWN_DEX_DEPLOYERS.includes(deployer)) {
            continue; // Skip non-DEX contract calls to avoid copying noise
          }
        } else {
          continue; // Skip non-contract_call transactions
        }

        const existing = await db.prisma.trade.findFirst({ where: { userId, walletId, txId: tx.tx_id } });
        if (existing) continue;

        const ageMs = Date.now() - (tx.block_time ?? 0) * 1000;
        if (ageMs > maxAgeHours * 3600_000) continue;

        // Interpret transfer events to extract swap details
        const stxSent = (tx.stx_transfers ?? []).find(t => t.sender === targetAddress);
        const stxRecv = (tx.stx_transfers ?? []).find(t => t.recipient === targetAddress);
        const ftSent = (tx.ft_transfers ?? []).find(t => t.sender === targetAddress);
        const ftRecv = (tx.ft_transfers ?? []).find(t => t.recipient === targetAddress);

        let tokenIn = "";
        let tokenOut = "";
        let amount = maxPerTrade;
        let direction: "BUY" | "SELL" = "BUY";

        if (stxSent && ftRecv) {
          // BUY: Spent STX, Received FT
          tokenIn = "STX";
          direction = "BUY";
          amount = Math.min((Number(stxSent.amount) / 1e6) * copyRatio, maxPerTrade);

          const assetId = ftRecv.asset_identifier;
          const matched = tokens.find(tok =>
            tok.contractId.toLowerCase() === assetId.split("::")[0]?.toLowerCase()
          );
          if (matched) {
            tokenOut = matched.symbol;
          } else {
            continue; // Skip if we cannot resolve the token being bought
          }
        } else if (ftSent && stxRecv) {
          // SELL: Spent FT, Received STX
          tokenOut = "STX";
          direction = "SELL";
          amount = Math.min((Number(stxRecv.amount) / 1e6) * copyRatio, maxPerTrade);

          const assetId = ftSent.asset_identifier;
          const matched = tokens.find(tok =>
            tok.contractId.toLowerCase() === assetId.split("::")[0]?.toLowerCase()
          );
          if (matched) {
            tokenIn = matched.symbol;
          } else {
            continue; // Skip if we cannot resolve the token being sold
          }
        } else if (ftSent && ftRecv) {
          // Cross-pair swap: Spent FT1, Received FT2
          const assetInId = ftSent.asset_identifier;
          const assetOutId = ftRecv.asset_identifier;

          const matchedIn = tokens.find(tok =>
            tok.contractId.toLowerCase() === assetInId.split("::")[0]?.toLowerCase()
          );
          const matchedOut = tokens.find(tok =>
            tok.contractId.toLowerCase() === assetOutId.split("::")[0]?.toLowerCase()
          );

          if (matchedIn && matchedOut) {
            tokenIn = matchedIn.symbol;
            tokenOut = matchedOut.symbol;
            direction = "BUY"; // Treat cross-pair as BUY of tokenOut
            amount = maxPerTrade; // Default to maxPerTrade
          } else {
            continue;
          }
        } else {
          continue; // Could not interpret as a direct swap
        }

        actions.push({
          tokenIn,
          tokenOut,
          amountIn: amount,
          direction,
          slippageBps,
          reason: `Copy: ${targetAddress.slice(0, 8)}... tx ${tx.tx_id.slice(0, 8)}`,
        });

        if (actions.length >= maxCopies) break;
      }

      return actions;
    } catch {
      return [];
    }
  }
}
