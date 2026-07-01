import { vi } from "vitest";

export const mockPrisma = {
  user: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  wallet: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  trade: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
  },
  tradingStrategy: {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  perpPosition: {
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  recommendation: {
    create: vi.fn(),
    findMany: vi.fn(),
  },
};

export const mockDbInstance = {
  findWalletById: vi.fn(),
  findTradeSettings: vi.fn(),
  prisma: mockPrisma,
};

export const mockTxInstance = {
  execute: vi.fn(),
  estimateFees: vi.fn(),
};

export const mockOpenAIClient = {
  chat: {
    completions: {
      create: vi.fn(),
    },
  },
};

export const mockGoogleClient = {
  generateContent: vi.fn(),
};
