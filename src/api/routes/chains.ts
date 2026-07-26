import { Router } from "express";
import type { Request, Response } from "express";
import { ChainAdapterRegistry } from "../../services/chains/chainAdapterRegistry.js";

const router = Router();

/**
 * The chains this deployment actually runs.
 *
 * Unauthenticated: which networks the product supports is public information,
 * and the token-discovery pages need it before a user has signed in. Nothing
 * user-specific is exposed — no addresses, no keys, no RPC URLs.
 *
 * Every chain picker in the web app and the Telegram bot reads this. No UI
 * hardcodes a chain list, so enabling a chain is a config change that shows up
 * everywhere at once rather than a code change in three places.
 */
router.get("/chains", (_req: Request, res: Response) => {
  const chains = ChainAdapterRegistry.getInstance()
    .list()
    .map((d) => ({
      chainId: d.chainId,
      family: d.family,
      displayName: d.displayName,
      nativeSymbol: d.nativeSymbol,
      nativeDecimals: d.nativeDecimals,
      stableSymbol: d.stableSymbol,
      isTestnet: d.isTestnet,
      tradable: d.tradable,
    }));

  res.json({ chains });
});

export default router;
