import { Router } from "express";
import { authenticate } from "../middleware/auth.js";
import { TokenController } from "../controllers/tokenController.js";

const router = Router();

router.get("/tokens", authenticate, TokenController.getTokens);
router.get("/tokens/pairs", authenticate, TokenController.getPairs);
router.get("/tokens/:pair/price", authenticate, TokenController.getPairPrice);
router.get("/me/tokens/blocked", authenticate, TokenController.getBlockedTokens);
router.post("/me/tokens/block", authenticate, TokenController.blockToken);
router.delete("/me/tokens/block/:contractId", authenticate, TokenController.unblockToken);
router.get("/tokens/gasless-supported", authenticate, TokenController.getGaslessSupported);

export default router;
