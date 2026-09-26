import { Router } from "express";
import type { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { TokenDiscoveryService } from "../../services/tokenDiscovery.js";
import { CandleService } from "../../services/quant/candleService.js";
import { ChainAdapterRegistry } from "../../services/chains/chainAdapterRegistry.js";
import { resolveTradesSource } from "../../services/marketData/trades/index.js";
import { RedisService } from "../../services/redis.js";
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
const VALID_ASSET_CLASSES = new Set(["CRYPTO", "EQUITY"]);

/** Rows in the recent-trades panel, and entries in the leaderboard. */
const SWAP_FEED_LIMIT = 50;
const TRADER_LEADERBOARD_LIMIT = 20;

/**
 * Shortens an address or hash for display, keeping the full value beside it.
 *
 * Presentation stays in the route rather than in the source: a `TradesSource`
 * reports what traded, and how much of a hash fits in a column is a decision
 * about a table.
 */
function shorten(value: string): string {
  return value.length > 10 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

/** How long an aggregate is reused. Short enough to feel live, long enough to matter. */
const CACHE_TTL_SECONDS = 60;

/**
 * Memoises an expensive read in Redis.
 *
 * Cache failures are not request failures: an unreachable Redis falls through
 * to the query, which is slower but correct. The reverse — failing the request
 * because the cache is down — would turn a performance dependency into an
 * availability one.
 */
async function cached<T>(key: string, compute: () => Promise<T>): Promise<T> {
  const redis = RedisService.getInstance();
  const cacheKey = `discovery:${key}`;

  try {
    const hit = await redis.get(cacheKey);
    if (hit) return JSON.parse(hit) as T;
  } catch {
    // Fall through and compute.
  }

  const value = await compute();

  try {
    await redis.set(cacheKey, JSON.stringify(value), CACHE_TTL_SECONDS);
  } catch {
    // Serving the value matters; storing it doesn't.
  }

  return value;
}

/** GET /api/tokens/discover — cross-chain listing. */
router.get("/tokens/discover", async (req: Request, res: Response) => {
  try {
    const sortParam = String(req.query.sort ?? "volume");
    const assetClassParam = String(req.query.assetClass ?? "").toUpperCase();
    const result = await TokenDiscoveryService.getInstance().discover({
      chainId: req.query.chainId ? String(req.query.chainId) : undefined,
      query: req.query.q ? String(req.query.q) : undefined,
      category: VALID_CATEGORIES.has(String(req.query.category ?? ""))
        ? (String(req.query.category) as "trending")
        : undefined,
      assetClass: VALID_ASSET_CLASSES.has(assetClassParam)
        ? (assetClassParam as "CRYPTO" | "EQUITY")
        : undefined,
      sort: VALID_SORTS.has(sortParam) ? (sortParam as "volume") : "volume",
      page: req.query.page ? parseInt(String(req.query.page), 10) : 1,
      pageSize: req.query.pageSize ? parseInt(String(req.query.pageSize), 10) : 25,
    });

    res.json({
      ...result,
      items: result.items.map(serialiseToken),
      // The provider that actually answered, not a constant. This was
      // hardcoded to "dex" on both routes regardless of where the numbers came
      // from — a field asserting a provenance it had not checked.
      priceSource: TokenDiscoveryService.getInstance().marketData().name,
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
      // The provider that actually answered, not a constant. This was
      // hardcoded to "dex" on both routes regardless of where the numbers came
      // from — a field asserting a provenance it had not checked.
      priceSource: TokenDiscoveryService.getInstance().marketData().name,
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
    // Addressed by contract, not by symbol. Going back through the symbol
    // re-resolves a token that was already resolved, and on a chain listing two
    // tokens with one ticker it can resolve to the other one.
    const candles = await CandleService.getInstance().getCandlesForContract(
      chainId,
      contractId,
      timeframe,
      limit
    );

    res.json({ symbol: token.symbol, chainId, timeframe, candles });
  } catch (error) {
    logger.error("Token candles failed", { error });
    res.status(500).json({ error: "Failed to load candles" });
  }
});

/** GET /api/tokens/:chainId/:contractId/swaps — recent transactions. */
router.get("/tokens/:chainId/:contractId/swaps", async (req: Request, res: Response) => {
  try {
    const chainId = String(req.params.chainId);
    const contractId = String(req.params.contractId).toLowerCase();
    const token = await TokenDiscoveryService.getInstance().getToken(chainId, contractId);

    // Through the source rather than a query in the handler. These two routes
    // were the last places that read the indexer's tables inline, which meant
    // the two most swap-shaped surfaces in the product were the only ones that
    // could not follow the configured market-data source anywhere.
    const source = resolveTradesSource();
    const feed = await source.recentSwaps(chainId, contractId, SWAP_FEED_LIMIT);

    res.json({
      symbol: token?.symbol ?? "TOKEN",
      chainId,
      source: source.name,
      swaps: feed.swaps.map((s) => ({
        txHash: shorten(s.txHash),
        fullTxHash: s.txHash,
        timestamp: s.timestamp,
        type: s.isBuy ? "BUY" : "SELL",
        amountUsd: s.volumeUsd,
        priceUsd: s.priceUsd,
        traderAddress: s.traderAddress ? shorten(s.traderAddress) : "Unknown",
        fullAddress: s.traderAddress ?? undefined,
      })),
      ...(feed.note ? { message: feed.note } : {}),
    });
  } catch (error) {
    logger.error("Token swaps failed", { error });
    res.status(500).json({ error: "Failed to load swaps" });
  }
});

/** GET /api/tokens/:chainId/:contractId/traders — top traders. */
router.get("/tokens/:chainId/:contractId/traders", async (req: Request, res: Response) => {
  try {
    const chainId = String(req.params.chainId);
    const contractId = String(req.params.contractId).toLowerCase();
    const token = await TokenDiscoveryService.getInstance().getToken(chainId, contractId);

    const source = resolveTradesSource();
    // Cached: a public, unauthenticated route whose answer is an aggregate
    // over a 24-hour window, which does not change meaningfully between two
    // requests a second apart — and against the external source it is also a
    // call from a per-minute budget.
    const feed = await cached(`traders:${source.name}:${chainId}:${contractId}`, () =>
      source.topTraders(chainId, contractId, TRADER_LEADERBOARD_LIMIT)
    );

    res.json({
      symbol: token?.symbol ?? "TOKEN",
      chainId,
      source: source.name,
      traders: feed.traders.map((t, idx) => ({
        rank: idx + 1,
        address: shorten(t.address),
        fullAddress: t.address,
        tag: idx === 0 ? "Top Trader" : "Active Trader",
        volumeUsd: t.volumeUsd,
        trades: t.trades,
      })),
      ...(feed.note ? { message: feed.note } : {}),
    });
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
