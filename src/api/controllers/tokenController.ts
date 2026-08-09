import type { Request, Response, NextFunction } from "express";
import { DEXRegistry } from "../../services/dex/dexRegistry.js";
import { DatabaseService } from "../../services/db.js";
import { TokenDiscoveryService } from "../../services/tokenDiscovery.js";
import { ChainAdapterRegistry } from "../../services/chains/chainAdapterRegistry.js";
import { ConfigManager } from "../../config.js";
import { logger } from "../../utils/logger.js";
import { InternalError } from "../errors.js";
import type { TokenMarketData } from "../../services/marketData/types.js";
import type { ChainId } from "../../types/chain.js";

const VELUMX_SUPPORTED_FEE_TOKENS = [
  { symbol: "USDC", contractId: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.usdc-token" },
  { symbol: "WELSH", contractId: "SP3NE50GEXFG9SZGTT51P40X2CKYSZ5CC4ZTZ7A2G.welshcorgicoin-token" },
  { symbol: "ALEX", contractId: "SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.token-alex" },
];

/**
 * Display name for a chain, from the registry rather than a literal map.
 *
 * The previous substring-matching table was both duplicated (the same names
 * live in each descriptor) and wrong by construction: "arc" is a substring of
 * plenty of chain names, so the checks were order-dependent, and any chain
 * added via CUSTOM_EVM_CHAINS fell through to a shouted chain id.
 */
function getChainDisplayName(chainId: string): string {
  const descriptor = ChainAdapterRegistry.getInstance().find(chainId);
  if (descriptor) return descriptor.displayName;

  const network = chainId.split(":")[0] ?? chainId;
  return network.charAt(0).toUpperCase() + network.slice(1);
}

/** Explorer link for a token, when its chain is one we run. */
function explorerUrlFor(chainId: string, contractId: string): string | null {
  const descriptor = ChainAdapterRegistry.getInstance().find(chainId);
  return descriptor ? descriptor.explorerAddressUrl(contractId) : null;
}

/**
 * The wire shape for one row.
 *
 * Metrics stay nullable end to end. Collapsing null to 0 here is the tempting
 * simplification and it is what made the old table unreadable: a token we have
 * no volume data for and one that genuinely traded nothing render identically,
 * and both sort into the same place.
 */
/**
 * The wire shape for one token row.
 *
 * Exported because the discovery *list* endpoint returned raw Prisma rows
 * while the *detail* endpoint returned this — two different contracts for the
 * same entity, so a client had to know which one it was talking to. The list
 * now uses it too.
 */
export function serialiseToken(row: {
  chainId: string;
  contractId: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl?: string | null;
  dexId?: string | null;
  priceUsd?: number | null;
  priceChange5m?: number | null;
  priceChange1h?: number | null;
  priceChange6h?: number | null;
  priceChange24h?: number | null;
  volume24h?: number | null;
  liquidityUsd?: number | null;
  marketCapUsd?: number | null;
  txnsBuys24h?: number | null;
  txnsSells24h?: number | null;
  pairCreatedAt?: Date | null;
  isVerified?: boolean;
}) {
  return {
    contractId: row.contractId,
    symbol: row.symbol,
    name: row.name,
    decimals: row.decimals,
    chainId: row.chainId,
    chainName: getChainDisplayName(row.chainId),
    dexId: row.dexId || "DEX",
    icon: row.logoUrl || undefined,
    priceUsd: row.priceUsd ?? null,
    priceChange: {
      m5: row.priceChange5m ?? null,
      h1: row.priceChange1h ?? null,
      h6: row.priceChange6h ?? null,
      h24: row.priceChange24h ?? null,
    },
    volume24h: row.volume24h ?? null,
    marketCapUsd: row.marketCapUsd ?? null,
    liquidityUsd: row.liquidityUsd ?? null,
    txns24h: {
      buys: row.txnsBuys24h ?? null,
      sells: row.txnsSells24h ?? null,
    },
    pairCreatedAt: row.pairCreatedAt ? new Date(row.pairCreatedAt).getTime() : null,
    isVerified: row.isVerified ?? false,
    explorerUrl: explorerUrlFor(row.chainId, row.contractId),
  };
}

/** Provider search results share the row shape, minus the catalogue fields. */
function serialiseMarketData(m: TokenMarketData) {
  return serialiseToken({
    chainId: m.chainId,
    contractId: m.contractId,
    symbol: m.symbol ?? m.contractId.slice(0, 8),
    name: m.name ?? "",
    decimals: m.decimals ?? 18,
    logoUrl: m.logoUrl,
    dexId: m.dexId,
    priceUsd: m.priceUsd,
    priceChange5m: m.priceChange5m,
    priceChange1h: m.priceChange1h,
    priceChange6h: m.priceChange6h,
    priceChange24h: m.priceChange24h,
    volume24h: m.volume24h,
    liquidityUsd: m.liquidityUsd,
    marketCapUsd: m.marketCapUsd,
    txnsBuys24h: m.txnsBuys24h,
    txnsSells24h: m.txnsSells24h,
    pairCreatedAt: m.pairCreatedAt,
    isVerified: false,
  });
}

export class TokenController {
  static async getTokens(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const query = req.query.query ? String(req.query.query).trim() : undefined;
      const rawChainId = req.query.chainId ? String(req.query.chainId).trim() : undefined;
      const chainId = rawChainId && rawChainId !== "all" ? (rawChainId as ChainId) : undefined;
      const category = req.query.category ? (String(req.query.category).trim() as "trending" | "gainers" | "new" | "all") : undefined;
      const sort = req.query.sort ? (String(req.query.sort).trim() as "volume" | "change" | "liquidity" | "symbol" | "mcap") : undefined;
      const page = req.query.page ? Math.max(1, parseInt(String(req.query.page), 10) || 1) : 1;
      const pageSize = req.query.pageSize ? Math.min(100, Math.max(1, parseInt(String(req.query.pageSize), 10) || 25)) : 25;

      const includeTestnets = String(req.query.includeTestnets ?? "") === "true";

      const discovery = TokenDiscoveryService.getInstance();
      const { items, total } = await discovery.discover({
        query,
        chainId,
        category,
        sort,
        page,
        pageSize,
        includeTestnets,
      });

      // A search that the catalogue can't answer is asked of the market-data
      // provider directly — the user may be looking up a token this deployment
      // has never routed and so has never catalogued.
      if (total === 0 && query) {
        const found = await discovery
          .marketData()
          .search(query, chainId)
          .catch(() => []);

        if (found.length > 0) {
          res.json({
            tokens: found.map(serialiseMarketData),
            total: found.length,
            page: 1,
            pageSize: found.length,
            source: discovery.marketData().name,
          });
          return;
        }
      }

      res.json({
        tokens: items.map(serialiseToken),
        total,
        page,
        pageSize,
        source: discovery.marketData().name,
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
