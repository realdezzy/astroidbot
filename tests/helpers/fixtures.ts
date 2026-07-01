import type { User, Wallet, Trade, TradeAgent, TradingStrategy, TradeSettings } from "@prisma/client";

export function createMockUser(overrides?: Partial<User>): User {
  return {
    id: 1,
    telegramId: 123456789n,
    email: "user@example.com",
    passwordHash: "hashedpassword",
    username: "testuser",
    emailVerified: true,
    referralCode: "ref-code-123",
    referredBy: null,
    points: 0,
    isActive: true,
    isAdmin: false,
    createdAt: new Date(),
    ...overrides,
  };
}

export function createMockWallet(overrides?: Partial<Wallet>): Wallet {
  return {
    id: 1,
    userId: 1,
    address: "SP3FBR2AGK5H9QBDH3EEN6DF8EK8JY7RX8QJ5SVTE",
    name: "Main Wallet",
    encryptedKey: "encrypted-hex-key",
    balance: 100.0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function createMockTrade(overrides?: Partial<Trade>): Trade {
  return {
    id: 1,
    walletId: 1,
    userId: 1,
    direction: "BUY",
    tokenIn: "STX",
    tokenOut: "sUSDT",
    amountIn: 10.0,
    amountOut: 20.0,
    feeAmount: 0.03,
    feeBps: 30,
    txId: "0xmockedtxid",
    status: "CONFIRMED",
    errorMessage: null,
    isGasless: false,
    relayerFeeAmount: null,
    relayerFeeToken: null,
    amountInUsd: 20.0,
    amountOutUsd: 20.0,
    createdAt: new Date(),
    confirmedAt: new Date(),
    ...overrides,
  };
}

export function createMockAgent(overrides?: Partial<TradeAgent>): TradeAgent {
  return {
    id: 1,
    userId: 1,
    name: "Autonomous Agent",
    context: "custom",
    aiMode: "autonomous",
    config: {},
    state: {},
    model: "deepseek-v4-pro",
    isActive: true,
    failureCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function createMockStrategy(overrides?: Partial<TradingStrategy>): TradingStrategy {
  return {
    id: 1,
    userId: 1,
    agentId: 1,
    type: "dca",
    config: {
      tokenIn: "STX",
      tokenOut: "sUSDT",
      amount: 5,
      intervalMinutes: 60,
      priceCondition: "always",
      priceThresholdUsd: 0,
      maxSlippageBps: 100,
      walletIds: [1],
    },
    state: {},
    isActive: true,
    failureCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function createMockTradeSettings(overrides?: Partial<TradeSettings>): TradeSettings {
  return {
    id: 1,
    userId: 1,
    context: "personal",
    chain: "stacks:mainnet",
    slippageBps: 100,
    maxPositionPct: 25.0,
    dailyLossLimit: 5.0,
    rebalanceThreshold: 2.0,
    useGasless: false,
    gaslessFeeToken: "USDC",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}
