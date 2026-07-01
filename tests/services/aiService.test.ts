import { describe, it, expect, vi, beforeEach, beforeAll } from "vitest";
import { AIOrchestrator } from "../../src/services/ai.js";
import { ConfigManager } from "../../src/config.js";
import { RedisService } from "../../src/services/redis.js";
import { DatabaseService } from "../../src/services/db.js";
import OpenAI from "openai";

vi.mock("openai", () => {
  const mockCreate = vi.fn().mockResolvedValue({
    choices: [
      {
        message: {
          content: '{"overallSentiment": "BULLISH", "confidence": 0.8, "reasoning": "Looks good"}',
        },
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
    },
  });

  return {
    default: vi.fn().mockImplementation(() => {
      return {
        chat: {
          completions: {
            create: mockCreate,
          },
        },
      };
    }),
  };
});

const mockGet = vi.fn();
const mockSet = vi.fn();
vi.mock("../../src/services/redis.js", () => {
  return {
    RedisService: {
      getInstance: () => ({
        get: mockGet,
        set: mockSet,
      }),
    },
  };
});

const mockCreateLog = vi.fn();
vi.mock("../../src/services/db.js", () => {
  return {
    DatabaseService: {
      getInstance: () => ({
        prisma: {
          aIRecommendation: {
            create: mockCreateLog,
          },
        },
      }),
    },
  };
});

describe("AIOrchestrator Service Unit Tests", () => {
  beforeAll(() => {
    process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
    process.env.AES_KEY = "testkey";
    process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
    process.env.OPENAI_API_KEY = "mock-openai-key";
    if (process.env.TELEGRAM_WEBHOOK_URL === "") {
      delete process.env.TELEGRAM_WEBHOOK_URL;
    }
    if (process.env.VELUMX_RELAYER_URL === "") {
      delete process.env.VELUMX_RELAYER_URL;
    }
    ConfigManager.load();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    // Re-apply OpenAI mock after reset (vi.resetAllMocks wipes implementations)
    vi.mocked(OpenAI).mockImplementation(() => ({
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: '{"overallSentiment": "BULLISH", "confidence": 0.8, "reasoning": "Looks good"}' } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
        },
      },
    } as any));
    mockGet.mockResolvedValue(null);
    mockSet.mockResolvedValue("OK");
    mockCreateLog.mockResolvedValue({});
  });

  it("should process analyzeSentiment request using LLM client and cache it", async () => {
    const orchestrator = AIOrchestrator.getInstance();

    const priceData = { STX: [1.5, 1.6] };
    const sentiment = await orchestrator.analyzeSentiment(10, ["STX"], priceData);

    expect(sentiment).toEqual(expect.objectContaining({
      overallSentiment: "BULLISH",
      confidence: 0.8,
      reasoning: "Looks good",
    }));
    expect(mockSet).toHaveBeenCalled();
  });

  it("should return cached recommendation if cache hit occurs", async () => {
    mockGet.mockResolvedValue(JSON.stringify({
      overallSentiment: "BEARISH",
      confidence: 0.9,
      reasoning: "Looks bad",
    }));
    const orchestrator = AIOrchestrator.getInstance();

    const priceData = { STX: [1.5, 1.6] };
    const sentiment = await orchestrator.analyzeSentiment(10, ["STX"], priceData);

    expect(sentiment).toEqual(expect.objectContaining({
      overallSentiment: "BEARISH",
      confidence: 0.9,
      reasoning: "Looks bad",
    }));
    expect(mockSet).not.toHaveBeenCalled();
  });
});
