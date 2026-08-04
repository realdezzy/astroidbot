import { z } from "zod";

export const telegramLoginSchema = z.object({
  id: z.coerce.bigint(),
  first_name: z.string().optional(),
  username: z.string().optional(),
  auth_date: z.coerce.number(),
  hash: z.string(),
});

export const emailRegisterSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).regex(/[a-zA-Z]/, "Password must contain a letter").regex(/[0-9]/, "Password must contain a number"),
  username: z.string().min(2).max(32).optional(),
});

export const emailLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const passwordResetRequestSchema = z.object({
  email: z.string().email(),
});

export const passwordResetExecuteSchema = z.object({
  newPassword: z.string().min(8).regex(/[a-zA-Z]/).regex(/[0-9]/),
});

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).regex(/[a-zA-Z]/).regex(/[0-9]/),
});

export const linkTelegramSchema = z.object({
  id: z.coerce.bigint(),
  first_name: z.string().optional(),
  username: z.string().optional(),
  auth_date: z.coerce.number(),
  hash: z.string(),
});

export const linkEmailSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export const refreshTokenSchema = z.object({
  refreshToken: z.string().min(1),
});

export const updateSettingsSchema = z.object({
  context: z.enum(["personal", "market_making"]).optional(),
  chain: z.string().optional(),
  slippageBps: z.number().int().min(1).max(10000).optional(),
  maxPositionPct: z.number().min(0).max(100).optional(),
  dailyLossLimit: z.number().min(0).max(100).optional(),
  rebalanceThreshold: z.number().min(0).max(100).optional(),
  useGasless: z.boolean().optional(),
  gaslessFeeToken: z.string().optional(),
});

export const tradeQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z.enum(["PENDING", "BROADCAST", "CONFIRMED", "FAILED"]).optional(),
  direction: z.enum(["BUY", "SELL"]).optional(),
});

export const paginatedResponse = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z.object({
    items: z.array(itemSchema),
    total: z.number().int(),
    page: z.number().int(),
    limit: z.number().int(),
  });

export type TelegramLoginInput = z.infer<typeof telegramLoginSchema>;
export type EmailRegisterInput = z.infer<typeof emailRegisterSchema>;
export type EmailLoginInput = z.infer<typeof emailLoginSchema>;
export type RefreshTokenInput = z.infer<typeof refreshTokenSchema>;
export type UpdateSettingsInput = z.infer<typeof updateSettingsSchema>;
export type TradeQueryInput = z.infer<typeof tradeQuerySchema>;

export const createSocialAccountSchema = z.object({
  platform: z.enum(["x", "farcaster"]),
  handle: z.string().min(1).max(64),
  platformUserId: z.string().min(1).max(128),
  perTradeLimitUsd: z.number().positive().default(100),
  dailyLimitUsd: z.number().positive().default(500),
  autoExecute: z.boolean().default(false),
});

export const updateSocialAccountSchema = z.object({
  perTradeLimitUsd: z.number().positive().optional(),
  dailyLimitUsd: z.number().positive().optional(),
  autoExecute: z.boolean().optional(),
  enabled: z.boolean().optional(),
});

export const confirmSocialCommandSchema = z.object({
  token: z.string().min(1),
});

export type CreateSocialAccountInput = z.infer<typeof createSocialAccountSchema>;
export type UpdateSocialAccountInput = z.infer<typeof updateSocialAccountSchema>;
export type ConfirmSocialCommandInput = z.infer<typeof confirmSocialCommandSchema>;


/**
 * The chain is validated against the registry in the controller rather than
 * enumerated here: which chains exist is a deployment decision
 * (`ENABLED_CHAINS`), and a hardcoded list would reject a newly-enabled chain
 * with a validation error that mentions nothing about configuration.
 */
export const updateGasSponsorshipSchema = z.object({
  chainId: z.string().min(1).max(64),
  enabled: z.boolean(),
});

export type UpdateGasSponsorshipInput = z.infer<typeof updateGasSponsorshipSchema>;
