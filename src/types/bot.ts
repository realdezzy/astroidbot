import type { Context, SessionFlavor } from "grammy";

export interface SessionData {
  waitingFor: string | null;
  backScreen: string | undefined;
  emailToLink: string | undefined;
  emailOtp: string | undefined;
  emailOtpExpiry: number | undefined;
  tradePair: string | undefined;
  tradeDir: string | undefined;
  tradeAmount: number | string | undefined;
  tradeWalletId: number | undefined;
  tradeTokenIn: string | undefined;
  tradeTokenOut: string | undefined;
  limitPair: string | undefined;
  limitDir: string | undefined;
  limitAmount: number | string | undefined;
  limitPrice: number | string | undefined;
  tempPrivateKey: string | undefined;
  tempAddress: string | undefined;
  tempAgentName: string | undefined;
  tempAgentContext: string | undefined;
  activeAgentId: number | undefined;
  tempStrategyType: string | undefined;
  tempStrategyConfig: Record<string, any> | undefined;
  tempStrategyWalletIds: number[] | undefined;
  tempStrategyFields: string[] | undefined;
  tempStrategyFieldIndex: number | undefined;
  chatHistory?: { role: "user" | "assistant"; content: string }[];
}

export type BotContext = Context & SessionFlavor<SessionData>;
