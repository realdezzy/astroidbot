import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../middleware/auth.js";
import { validateBody, validateQuery } from "../middleware/validate.js";
import { updateSettingsSchema, tradeQuerySchema } from "../../validation/api/schemas.js";
import { UserController } from "../controllers/userController.js";

const router = Router();

const generateWalletSchema = z.object({
  name: z.string().min(1).max(64).optional(),
});

const importWalletSchema = z.object({
  privateKey: z.string().min(32).max(128),
  name: z.string().min(1).max(64).optional(),
});

const revealKeySchema = z.object({
  password: z.string().min(1),
});

const walletTransferSchema = z.object({
  toAddress: z.string().min(1),
  amount: z.number().positive(),
  token: z.string().min(1),
});

const executeTradeSchema = z.object({
  walletId: z.number().int(),
  tokenIn: z.string().min(1),
  tokenOut: z.string().min(1),
  amountIn: z.number().positive(),
  direction: z.enum(["BUY", "SELL"]),
  minAmountOut: z.number().positive().optional(),
  dex: z.string().optional(),
});

router.get("/me", authenticate, UserController.getMe);
router.get("/me/wallets", authenticate, UserController.getWallets);
router.get("/me/trades", authenticate, validateQuery(tradeQuerySchema), UserController.getTrades);
router.get("/me/settings", authenticate, UserController.getSettings);
router.put("/me/settings", authenticate, validateBody(updateSettingsSchema), UserController.updateSettings);
router.get("/me/recommendations", authenticate, UserController.getRecommendations);

router.post("/me/wallets/generate", authenticate, validateBody(generateWalletSchema), UserController.generateWallet);
router.post("/me/wallets/import", authenticate, validateBody(importWalletSchema), UserController.importWallet);
router.delete("/me/wallets/:id", authenticate, UserController.deleteWallet);
router.post("/me/wallets/:id/reveal", authenticate, validateBody(revealKeySchema), UserController.revealPrivateKey);
router.get("/me/wallets/:id/balances", authenticate, UserController.getWalletBalances);
router.post("/me/wallets/:id/transfer", authenticate, validateBody(walletTransferSchema), UserController.transferWallet);

router.post("/me/trades/execute", authenticate, validateBody(executeTradeSchema), UserController.executeTrade);
router.get("/me/trades/quote", authenticate, UserController.getTradeQuote);
router.get("/me/analytics", authenticate, UserController.getAnalytics);

export default router;
