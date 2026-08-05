import { Router } from "express";
import type { Request, Response } from "express";
import rateLimit from "express-rate-limit";
import { TokenDiscoveryService } from "../../services/tokenDiscovery.js";
import { CandleService } from "../../services/quant/candleService.js";
import { ChainAdapterRegistry } from "../../services/chains/chainAdapterRegistry.js";
import { logger } from "../../utils/logger.js";
import { serialiseToken } from "../controllers/tokenController.js";

const router = Router();

/**
 * Public token discovery.
 *
 * Unauthenticated by design: discovery is the top of the funnel, and requiring
 * a login to browse tokens defeats its purpose. Nothing user-specific is
 * reachable here — it is a read-only view of the token catalogue, and the
 * authenticated blocklist endpoints stay where they are.
 *
 * Rate-limited separately from /api because these are cheap-to-call,
 * cache-friendly reads that anyone on the internet can hit.
 */
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

/** GET /api/tokens/discover — cross-chain listing, chain filter optional. */
router.get("/tokens/discover", async (req: Request, res: Response) => {
  try {
    const sortParam = String(req.query.sort ?? "volume");
    const result = await TokenDiscoveryService.getInstance().discover({
      chainId: req.query.chainId ? String(req.query.chainId) : undefined,
      query: req.query.q ? String(req.query.q) : undefined,
      // Trending / Gainers / New. The service has supported these since
      // discovery shipped; the route was dropping them, so the tabs a
      // DexScreener-style page is built around could not be wired up.
      category: VALID_CATEGORIES.has(String(req.query.category ?? ""))
        ? (String(req.query.category) as "trending")
        : undefined,
      sort: VALID_SORTS.has(sortParam) ? (sortParam as "volume") : "volume",
      page: req.query.page ? parseInt(String(req.query.page), 10) : 1,
      pageSize: req.query.pageSize ? parseInt(String(req.query.pageSize), 10) : 25,
    });

    // Serialised through the same function as the detail endpoint. Returning
    // raw Prisma rows here meant the list and the detail view of the same
    // token had different field names and different nesting.
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
      // False when the chain isn't enabled here, so the UI can show the token
      // without offering a Trade button that could not possibly work.
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
    // Scoped by chainId: candles for "USDC" differ per chain, and reading them
    // unscoped would return another chain's series.
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

export default router;
