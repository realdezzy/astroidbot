import type { Request, Response, NextFunction } from "express";
import { DEXRegistry } from "../../services/dex/dexRegistry.js";
import { DatabaseService } from "../../services/db.js";
import { ConfigManager } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { InternalError } from "../errors.js";

const VELUMX_SUPPORTED_FEE_TOKENS = [
  { symbol: "USDC", contractId: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.usdc-token" },
  { symbol: "WELSH", contractId: "SP3NE50GEXFG9SZGTT51P40X2CKYSZ5CC4ZTZ7A2G.welshcorgicoin-token" },
  { symbol: "ALEX", contractId: "SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.token-alex" },
];

export class TokenController {
  static async getTokens(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const registry = DEXRegistry.getInstance();
      const tokens = registry.getCachedTokens();

      res.json({
        tokens: tokens.map((t) => ({
          contractId: t.contractId,
          symbol: t.symbol,
          name: t.name,
          decimals: t.decimals,
        })),
        total: tokens.length,
      });
    } catch (error) {
      logger.error("Failed to fetch tokens", { error });
      next(new InternalError());
    }
  }

  static async getPairs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const registry = DEXRegistry.getInstance();
      const pairs = registry.getTradingPairs();

      res.json({
        pairs: pairs.map((p) => ({
          tokenX: p.tokenX,
          tokenY: p.tokenY,
          contractId: p.contractId,
          balanceX: p.balanceX,
          balanceY: p.balanceY,
        })),
        total: pairs.length,
      });
    } catch (error) {
      logger.error("Failed to fetch pairs", { error });
      next(new InternalError());
    }
  }

  static async getPairPrice(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const pairParam = String(req.params.pair ?? "");
      const [tokenA, tokenB] = pairParam
        .split("-")
        .map((s: string) => s.trim());

      if (!tokenA || !tokenB) {
        return res.status(400).json({
          error: "Pair format: TOKENA-TOKENB (contract IDs)",
        });
      }

      const registry = DEXRegistry.getInstance();
      const { midPrice, priceImpactBuy, priceImpactSell } = await registry.getPairPrice(tokenA, tokenB);

      res.json({
        tokenA,
        tokenB,
        midPrice: midPrice > 0 ? midPrice : null,
        priceImpactBuy,
        priceImpactSell,
      });
    } catch (error) {
      logger.error("Failed to fetch price", { error });
      next(new InternalError());
    }
  }

  static async getBlockedTokens(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const db = DatabaseService.getInstance();
      const blocked = await db.getBlockedTokens(req.userId!);
      res.json({ blocked });
    } catch (error) {
      logger.error("Failed to fetch blocked tokens", { error });
      next(new InternalError());
    }
  }

  static async blockToken(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const { contractId, symbol } = req.body as {
        contractId: string;
        symbol: string;
      };
      if (!contractId || !symbol) {
        return res.status(422).json({
          error: "contractId and symbol are required",
          code: "VALIDATION_ERROR",
        });
      }

      if (symbol.toUpperCase() === "STX" || contractId.toUpperCase() === "STX") {
        return res.status(400).json({
          error: "Cannot block native STX token",
          code: "VALIDATION_ERROR",
        });
      }

      const db = DatabaseService.getInstance();
      const result = await db.blockToken(req.userId!, contractId, symbol);
      res.status(201).json(result);
    } catch (error) {
      logger.error("Failed to block token", { error });
      next(new InternalError());
    }
  }

  static async unblockToken(req: Request, res: Response, next: NextFunction): Promise<Response | void> {
    try {
      const contractId = req.params.contractId as string;
      if (!contractId) {
        return res.status(422).json({
          error: "contractId is required",
          code: "VALIDATION_ERROR",
        });
      }

      const db = DatabaseService.getInstance();
      await db.unblockToken(req.userId!, contractId);
      res.json({ ok: true });
    } catch (error) {
      logger.error("Failed to unblock token", { error });
      next(new InternalError());
    }
  }

  static async getGaslessSupported(req: Request, res: Response): Promise<void> {
    const config = ConfigManager.getInstance().config;
    if (!config.VELUMX_RELAYER_URL) {
      res.json({ enabled: false, tokens: [] });
      return;
    }
    res.json({ enabled: true, tokens: VELUMX_SUPPORTED_FEE_TOKENS });
  }
}
