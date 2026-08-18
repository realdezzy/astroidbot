import { Router } from "express";
import type { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { TokenDiscoveryService } from "../../services/tokenDiscovery.js";
import { CandleService } from "../../services/quant/candleService.js";
import { ChainAdapterRegistry } from "../../services/chains/chainAdapterRegistry.js";
import { DatabaseService } from "../../services/db.js";
import { logger } from "../../utils/logger.js";
import { serialiseToken } from "../controllers/tokenController.js";

const router = Router();

const discoveryLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

router.use(discoveryLimiter);

const VALID_CATEGORIES = new Set(["trending", "gainers", "new", "all"]);
const VALID_SORTS = new Set(["volume", "change", "liquidity", "symbol"]);
const VALID_TIMEFRAMES = new Set(["1m", "5m", "15m", "1h", "4h", "1d"]);

/** GET /api/tokens/discover — cross-chain listing. */
router.get("/tokens/discover", async (req: Request, res: Response) => {
  try {
    const sortParam = String(req.query.sort ?? "volume");
    const result = await TokenDiscoveryService.getInstance().discover({
      chainId: req.query.chainId ? String(req.query.chainId) : undefined,
      query: req.query.q ? String(req.query.q) : undefined,
      category: VALID_CATEGORIES.has(String(req.query.category ?? ""))
        ? (String(req.query.category) as "trending")
        : undefined,
      sort: VALID_SORTS.has(sortParam) ? (sortParam as "volume") : "volume",
      page: req.query.page ? parseInt(String(req.query.page), 10) : 1,
      pageSize: req.query.pageSize ? parseInt(String(req.query.pageSize), 10) : 25,
    });

    res.json({
      ...result,
      items: result.items.map(serialiseToken),
      priceSource: "dex",
    });
  } catch (error) {
    logger.error("Token discovery failed", { error });
    res.status(500).json({ error: "Failed to load tokens" });
  }
});

/** GET /api/tokens/:chainId/:contractId — detail for one token. */
router.get("/tokens/:chainId/:contractId", async (req: Request, res: Response) => {
  try {
    const chainId = String(req.params.chainId);
    const contractId = String(req.params.contractId);

    const token = await TokenDiscoveryService.getInstance().getToken(chainId, contractId);
    if (!token) {
      return res.status(404).json({ error: "Token not found" });
    }

    const registry = ChainAdapterRegistry.getInstance();
    const descriptor = registry.has(chainId) ? registry.get(chainId).descriptor : undefined;

    res.json({
      ...token,
      priceSource: "dex",
      chain: descriptor
        ? {
            chainId: descriptor.chainId,
            displayName: descriptor.displayName,
            nativeSymbol: descriptor.nativeSymbol,
            stableSymbol: descriptor.stableSymbol,
            tradable: descriptor.tradable,
            explorerUrl: descriptor.explorerAddressUrl(contractId),
          }
        : null,
      tradable: descriptor?.tradable ?? false,
    });
  } catch (error) {
    logger.error("Token detail failed", { error });
    res.status(500).json({ error: "Failed to load token" });
  }
});

/** GET /api/tokens/:chainId/:contractId/candles — chart data. */
router.get("/tokens/:chainId/:contractId/candles", async (req: Request, res: Response) => {
  try {
    const chainId = String(req.params.chainId);
    const contractId = String(req.params.contractId);
    const timeframe = String(req.query.timeframe ?? "1h");

    if (!VALID_TIMEFRAMES.has(timeframe)) {
      return res.status(400).json({ error: `Unsupported timeframe "${timeframe}"` });
    }

    const token = await TokenDiscoveryService.getInstance().getToken(chainId, contractId);
    if (!token) {
      return res.status(404).json({ error: "Token not found" });
    }

    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? "100"), 10)));
    const candles = await CandleService.getInstance().getCandles(
      token.symbol,
      timeframe,
      limit,
      chainId
    );

    res.json({ symbol: token.symbol, chainId, timeframe, candles });
  } catch (error) {
    logger.error("Token candles failed", { error });
    res.status(500).json({ error: "Failed to load candles" });
  }
});

/** GET /api/tokens/:chainId/:contractId/swaps — recent transactions from indexer. */
router.get("/tokens/:chainId/:contractId/swaps", async (req: Request, res: Response) => {
  try {
    const chainId = String(req.params.chainId);
    const contractId = String(req.params.contractId).toLowerCase();
    const token = await TokenDiscoveryService.getInstance().getToken(chainId, contractId);
    const db = DatabaseService.getInstance();

    const pools = await db.prisma.indexedPool.findMany({
      where: {
        chainId,
        OR: [
          { baseToken: contractId },
          { quoteToken: contractId },
          { poolAddress: contractId },
        ],
      },
      select: { id: true },
    });

    if (pools.length === 0) {
      return res.json({
        symbol: token?.symbol ?? "TOKEN",
        chainId,
        swaps: [],
        message: "No indexed pools found for this token.",
      });
    }

    const poolIds = pools.map((p) => p.id);
    const rawSwaps = await db.prisma.indexedSwap.findMany({
      where: { poolId: { in: poolIds } },
      orderBy: [{ blockNumber: "desc" }, { logIndex: "desc" }],
      take: 50,
    });

    const swaps = rawSwaps.map((s) => {
      const fullTx = s.txKey.split(":")[0] ?? s.txKey;
      const txHashShort = fullTx.length > 10
        ? `${fullTx.slice(0, 6)}...${fullTx.slice(-4)}`
        : fullTx;

      const traderAddr = s.traderAddress;
      const traderShort = traderAddr && traderAddr.length > 10
        ? `${traderAddr.slice(0, 6)}...${traderAddr.slice(-4)}`
        : traderAddr ?? "Unknown";

      return {
        txHash: txHashShort,
        fullTxHash: fullTx,
        timestamp: s.createdAt,
        type: s.isBuy ? "BUY" : "SELL",
        amountUsd: s.volumeUsd,
        priceUsd: s.priceUsd,
        traderAddress: traderShort,
        fullAddress: traderAddr ?? undefined,
      };
    });

    res.json({ symbol: token?.symbol ?? "TOKEN", chainId, swaps });
  } catch (error) {
    logger.error("Token swaps failed", { error });
    res.status(500).json({ error: "Failed to load swaps" });
  }
});

/** GET /api/tokens/:chainId/:contractId/traders — top traders from indexer. */
router.get("/tokens/:chainId/:contractId/traders", async (req: Request, res: Response) => {
  try {
    const chainId = String(req.params.chainId);
    const contractId = String(req.params.contractId).toLowerCase();
    const token = await TokenDiscoveryService.getInstance().getToken(chainId, contractId);
    const db = DatabaseService.getInstance();

    const pools = await db.prisma.indexedPool.findMany({
      where: {
        chainId,
        OR: [
          { baseToken: contractId },
          { quoteToken: contractId },
          { poolAddress: contractId },
        ],
      },
      select: { id: true },
    });

    if (pools.length === 0) {
      return res.json({
        symbol: token?.symbol ?? "TOKEN",
        chainId,
        traders: [],
        message: "No indexed pools found for this token.",
      });
    }

    const poolIds = pools.map((p) => p.id);
    const aggregated = await db.prisma.indexedSwap.groupBy({
      by: ["traderAddress"],
      where: {
        poolId: { in: poolIds },
        traderAddress: { not: null },
      },
      _sum: { volumeUsd: true },
      _count: { _all: true },
      orderBy: { _sum: { volumeUsd: "desc" } },
      take: 20,
    });

    const traders = aggregated
      .filter((row) => Boolean(row.traderAddress))
      .map((row, idx) => {
        const addr = row.traderAddress!;
        const shortAddr = addr.length > 10 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;
        return {
          rank: idx + 1,
          address: shortAddr,
          fullAddress: addr,
          tag: idx === 0 ? "Top Trader" : "Active Trader",
          volumeUsd: row._sum.volumeUsd ?? 0,
          trades: row._count._all,
        };
      });

    res.json({ symbol: token?.symbol ?? "TOKEN", chainId, traders });
  } catch (error) {
    logger.error("Token traders failed", { error });
    res.status(500).json({ error: "Failed to load traders" });
  }
});

/** GET /api/tokens/:chainId/:contractId/kols — tracked KOLs. */
router.get("/tokens/:chainId/:contractId/kols", async (req: Request, res: Response) => {
  try {
    const chainId = String(req.params.chainId);
    const contractId = String(req.params.contractId);
    const token = await TokenDiscoveryService.getInstance().getToken(chainId, contractId);

    res.json({
      symbol: token?.symbol ?? "TOKEN",
      chainId,
      kols: [],
      message: "No tracked KOL activity recorded for this token.",
    });
  } catch (error) {
    logger.error("Token kols failed", { error });
    res.status(500).json({ error: "Failed to load KOLs" });
  }
});

/** GET /api/tokens/:chainId/:contractId/holders — token holders. */
router.get("/tokens/:chainId/:contractId/holders", async (req: Request, res: Response) => {
  try {
    const chainId = String(req.params.chainId);
    const contractId = String(req.params.contractId);
    const token = await TokenDiscoveryService.getInstance().getToken(chainId, contractId);

    res.json({
      symbol: token?.symbol ?? "TOKEN",
      chainId,
      holders: [],
      message: "On-chain holder indexer pending for this network.",
    });
  } catch (error) {
    logger.error("Token holders failed", { error });
    res.status(500).json({ error: "Failed to load holders" });
  }
});

export default router;
