import type { SessionData } from "../types/bot.js";

export type WaitingFor =
  | "link_email"
  | "link_email_otp"
  | "link_email_password"
  | "import_wallet"
  | "import_wallet_name"
  | "agent_name"
  | "agent_context"
  | "agent_aimode"
  | "delete_wallet"
  | "trade_amount"
  | "trade_token_in"
  | "trade_token_out"
  | "trade_amount_custom"
  | "limit_amount"
  | "limit_price"
  | "broadcast_msg"
  | `strat_field:${string}`
  | `reveal_password:${number}`
  | `reveal_confirm:${number}`;

const FLOW_KEYS = [
  "emailToLink", "emailOtp", "emailOtpExpiry",
  "tradePair", "tradeDir", "tradeAmount", "tradeWalletId", "tradeTokenIn", "tradeTokenOut", "tradeQuote", "pendingActionId",
  "limitPair", "limitDir", "limitAmount", "limitPrice",
  "tempPrivateKey", "tempAddress", "importChainId",
  "tempAgentName", "tempAgentContext", "activeAgentId", "tempStrategyType", "tempStrategyConfig",
  "tempStrategyWalletIds", "tempStrategyFields", "tempStrategyFieldIndex",
] as const satisfies readonly (keyof SessionData)[];

/** Clear every transient wizard value while preserving navigation and chat history. */
export function clearFlow(session: SessionData): void {
  session.waitingFor = null;
  for (const key of FLOW_KEYS) delete session[key];
}

export function initialSession(): SessionData {
  return {
    waitingFor: null,
    backScreen: undefined,
    emailToLink: undefined,
    emailOtp: undefined,
    emailOtpExpiry: undefined,
    tradePair: undefined,
    tradeDir: undefined,
    tradeAmount: undefined,
    tradeWalletId: undefined,
    tradeTokenIn: undefined,
    tradeTokenOut: undefined,
    tradeQuote: undefined,
    pendingActionId: undefined,
    tokenMatches: undefined,
    limitPair: undefined,
    limitDir: undefined,
    limitAmount: undefined,
    limitPrice: undefined,
    tempPrivateKey: undefined,
    tempAddress: undefined,
    tempAgentName: undefined,
    tempAgentContext: undefined,
    activeAgentId: undefined,
    tempStrategyType: undefined,
    tempStrategyConfig: undefined,
    tempStrategyWalletIds: undefined,
    tempStrategyFields: undefined,
    tempStrategyFieldIndex: undefined,
    importChainId: undefined,
    activeChainId: undefined,
    chatHistory: undefined,
  };
}
