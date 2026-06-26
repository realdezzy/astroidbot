import crypto from "node:crypto";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { ConfigManager } from "../config.js";
import { logger } from "../utils/logger.js";
import { DatabaseService } from "./db.js";
import { DEXRegistry } from "./dex/dexRegistry.js";
import { PortfolioManager } from "./portfolio.js";
import { RiskManager } from "./riskManager.js";
import type {
  PortfolioTarget,
  GridSpreadConfig,
  AISentimentResult,
  TokenBalance,
} from "../types.js";

export class AIOrchestrator {
  private static instance: AIOrchestrator;
  private openaiClient: OpenAI | null = null;
  private googleClient: GoogleGenerativeAI | null = null;
  private readonly provider: string;
  private readonly model: string;

  private constructor() {
    const config = ConfigManager.getInstance().config;

    this.provider = config.AI_PROVIDER;
    this.model = config.AI_MODEL;

    if (this.provider === "openai" && config.OPENAI_API_KEY) {
      this.openaiClient = new OpenAI({ apiKey: config.OPENAI_API_KEY });
    }

    if (this.provider === "deepseek" && config.DEEPSEEK_API_KEY) {
      this.openaiClient = new OpenAI({
        apiKey: config.DEEPSEEK_API_KEY,
        baseURL: "https://api.deepseek.com/v1",
      });
    }

    if (this.provider === "google" && config.GOOGLE_AI_API_KEY) {
      this.googleClient = new GoogleGenerativeAI(config.GOOGLE_AI_API_KEY);
    }
  }

  static getInstance(): AIOrchestrator {
    if (!AIOrchestrator.instance) {
      AIOrchestrator.instance = new AIOrchestrator();
    }
    return AIOrchestrator.instance;
  }

  async parseCommand(
    userId: number,
    input: string,
    history?: { role: "user" | "assistant"; content: string }[]
  ): Promise<Record<string, unknown> | null> {
    let userContextStr = "";
    try {

      const db = DatabaseService.getInstance();
      const wallets = await db.findWalletsByUserId(userId);
      if (wallets.length > 0) {
        const tokens = await DEXRegistry.getInstance().getSwappableTokens();

        let grandTotal = 0;
        let totalPnl = 0;
        const walletDetails: string[] = [];

        for (const wallet of wallets) {
          const balances = await PortfolioManager.getInstance().fetchBalances(wallet.address, tokens, userId);
          const total = balances.reduce((s, b) => s + b.usdValue, 0);
          grandTotal += total;

          const tokenDetails = balances
            .map(b => `${b.symbol}: ${b.balance.toFixed(4)} ($${b.usdValue.toFixed(2)})`)
            .join(", ");
          walletDetails.push(
            `- Wallet "${wallet.name}" (${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}): Total $${total.toFixed(2)}. Holdings: [${tokenDetails || "No tokens"}]`
          );
        }

        try {
          totalPnl = await RiskManager.getInstance().getDailyPnl(userId);
        } catch { }

        userContextStr = `
User Portfolio/Wallet Context:
- Active Wallets: ${wallets.length}
- Grand Total Balance across all wallets: $${grandTotal.toFixed(2)}
- 24h PnL (profit/loss today): $${totalPnl.toFixed(2)}
Wallet Breakdown:
${walletDetails.join("\n")}
`;
      } else {
        userContextStr = `\nUser Portfolio/Wallet Context:\n- The user has no wallets configured yet.\n`;
      }
    } catch (e) {
      logger.error("Failed to build user context for parseCommand", { error: e instanceof Error ? e.message : String(e) });
    }

    let historyStr = "";
    if (history && history.length > 0) {
      historyStr =
        "\nRecent Conversation History:\n" +
        history.map(h => `${h.role === "user" ? "User" : "Assistant"}: ${h.content}`).join("\n") +
        "\n";
    }

    const prompt = `You are AstroidBot AI assistant, a powerful trading assistant on the Stacks blockchain. Parse the user's natural language input into a structured command.

AstroidBot Platform Information:
- Core Features: automated portfolio rebalancing, DCA strategies, grid trading, multi-wallet management, limit orders, and fast swaps on Stacks DEXs (ALEX & Bitflow).
- Telegram Commands/Screens:
  * '/start' or Main Menu: Home panel
  * '/trade': Swap tokens
  * '/portfolio': View balances and allocations
  * '/wallets': Create, import, reveal, or delete wallets
  * '/trades': Swap trade history
  * '/orders': Active limit orders
  * '/agents': AI automated trading agents
  * '/settings': Risk, slippage, and position configuration
  * '/link_email': Link email to access the web dashboard
  * '/help': Command list
- Web Dashboard Pages:
  * '/dashboard': Overview and portfolio stats
  * '/trade': Dex swap interface
  * '/wallets': Wallet manager
  * '/trades': History of trades
  * '/limit-orders': Limit order dashboard
  * '/agents': AI automated agents
  * '/tokens': Stacks tokens lists and analytics
  * '/settings': Personal settings
  * '/account': Account settings and password changes

Available actions:
1. trade: { action: "trade", tokenIn: string, tokenOut: string, amountIn: number, direction: "BUY" | "SELL" }
2. settings: { action: "settings", key: "slippageBps" | "maxPositionPct" | "dailyLossLimit" | "rebalanceThreshold", value: number }
3. info: { action: "info", topic: "portfolio" | "wallets" | "orders" | "status" | "settings" | "trades" | "agents" }
4. halt: { action: "halt" }
5. resume: { action: "resume" }
6. create_strategy: { action: "create_strategy", type: "portfolio_rebalance" | "grid" | "dca", config: object }
7. perp_trade: { action: "perp_trade", market: string, direction: "LONG" | "SHORT", margin: number, leverage: number }
   - Use this when the user explicitly requests leveraged trading, margin, long, short, or perpetual contracts (e.g. 'long BTC with 5x leverage' or 'open a 3x short on STX').
8. clarify: { action: "clarify", prompt: string, originalInput: string }
   - CRITICAL: Use this when the user input suggests making a trade or order (e.g. 'trade STX', 'buy STX', 'place STX order') but is AMBIGUOUS because it doesn't specify if it is a spot swap, a limit trade (limit order), or a perpetual leverage trade. The prompt must be a friendly question asking them to clarify their intent (e.g. 'Would you like to execute a spot swap, set a limit order, or open a perpetual leverage position?').
9. chat: { action: "chat", replyText: string, suggestedScreen?: "main" | "portfolio" | "wallets" | "trades" | "orders" | "agents" | "settings" | "trade", suggestedLink?: string }
   - Use this for greetings (e.g. 'hello', 'hi'), general platform questions (e.g. 'how do I import a wallet?', 'what can you do?'), page requests, or general conversation.
   - You must explain the platform features when greeted or asked.
   - If they request to go to a page or screen (e.g. 'take me to the wallets page' or 'open limit orders'), you should set "suggestedScreen" to the corresponding screen name, and/or set "suggestedLink" to the web page path (e.g. '/wallets', '/settings', '/dashboard', '/trade', '/trades', '/limit-orders', '/agents', '/tokens', '/account').
   - IMPORTANT rules for replyText:
     * If the user is asking for their wallet balance, total assets, or holdings, answer concisely using the User Portfolio/Wallet Context provided below. DO NOT redirect them or tell them to go to a page unless they specifically ask to go to a page (e.g. "take me to my portfolio page").
     * If the user asks how much they made/lost today, or what their daily profit/loss (PnL) is, answer concisely using the 24h PnL from the User Portfolio/Wallet Context provided below.
     * Keep your response helpful, natural, and highly concise. Do not include suggestedScreen or suggestedLink unless they specifically requested navigation (e.g. "go to the trade screen", "open wallets page").
10. unknown: { action: "unknown", reason: string }

${userContextStr}
${historyStr}
User input: "${input}"

Respond ONLY with valid JSON, no other text.`;

    const response = await this.callLLM(userId, "parse_command", prompt);
    try {
      return JSON.parse(extractJson(response));
    } catch {
      return null;
    }
  }

  async parseVoiceTranscript(
    userId: number,
    transcript: string,
    history?: { role: "user" | "assistant"; content: string }[]
  ): Promise<Record<string, unknown> | null> {
    return this.parseCommand(userId, transcript, history);
  }

  async analyzeSentiment(
    userId: number,
    tokenSymbols: string[],
    recentPriceData: Record<string, number[]>
  ): Promise<AISentimentResult> {
    const prompt = this.buildSentimentPrompt(tokenSymbols, recentPriceData);
    const response = await this.callLLM(userId, "sentiment", prompt);
    return this.parseSentimentResponse(response);
  }

  async generatePortfolioTargets(
    userId: number,
    currentBalances: TokenBalance[],
    sentiment: AISentimentResult
  ): Promise<PortfolioTarget[]> {
    const prompt = this.buildPortfolioPrompt(currentBalances, sentiment);
    const response = await this.callLLM(userId, "portfolio", prompt);
    return this.parsePortfolioResponse(response, currentBalances);
  }

  async generateGridSpreads(
    userId: number,
    tokenPair: string,
    volatility: number,
    currentMidPrice: number
  ): Promise<GridSpreadConfig> {
    const prompt = this.buildGridPrompt(tokenPair, volatility, currentMidPrice);
    const response = await this.callLLM(userId, "market_making", prompt);
    return this.parseGridResponse(response, tokenPair, currentMidPrice);
  }

  private buildSentimentPrompt(
    symbols: string[],
    priceData: Record<string, number[]>
  ): string {
    const dataStr = symbols
      .map((s) => {
        const prices = priceData[s] ?? [];
        const priceStr = prices.slice(-7).join(", ");
        const change = prices.length >= 2
          ? (((prices[prices.length - 1]! - prices[0]!) / prices[0]!) * 100).toFixed(2)
          : "N/A";
        return `${s}: recent prices [${priceStr}], 7d change: ${change}%`;
      })
      .join("\n");

    return `Analyze the following Stacks blockchain token price data and provide market sentiment.

Token data:
${dataStr}

Respond in JSON format:
{
  "overallSentiment": "BULLISH" | "BEARISH" | "NEUTRAL",
  "confidence": number (0-1),
  "reasoning": "string"
}`;
  }

  private buildPortfolioPrompt(
    balances: TokenBalance[],
    sentiment: AISentimentResult
  ): string {
    const totalValue = balances.reduce((sum, b) => sum + b.usdValue, 0);

    const balanceStr = balances
      .map((b) => {
        const pct = totalValue > 0 ? ((b.usdValue / totalValue) * 100).toFixed(1) : "0";
        return `${b.symbol}: $${b.usdValue.toFixed(2)} (${pct}% of portfolio)`;
      })
      .join("\n");

    return `You are a portfolio manager for a Stacks blockchain trading bot.

Current portfolio (total value: $${totalValue.toFixed(2)}):
${balanceStr}

Market sentiment: ${sentiment.overallSentiment} (confidence: ${sentiment.confidence})
Reasoning: ${sentiment.reasoning}

Propose target portfolio weight allocations for each token. Weights must sum to 1.0.
Consider: diversification, risk management, current market sentiment, and token fundamentals.

Respond in JSON format:
{
  "targets": [
    { "token": "SYMBOL", "targetWeight": number }
  ]
}`;
  }

  private buildGridPrompt(
    tokenPair: string,
    volatility: number,
    midPrice: number
  ): string {
    return `Configure a grid-based market making strategy for the ${tokenPair} pair on Stacks DEX.

Current mid-price: ${midPrice}
Recent volatility: ${(volatility * 100).toFixed(2)}%

Determine optimal grid parameters considering:
- Higher volatility = wider spreads
- Lower volatility = tighter spreads, more levels
- Grid levels should be symmetric above and below mid-price

Respond in JSON format:
{
  "levels": number (3-10),
  "spreadBps": number (basis points per level)
}`;
  }

  async callLLM(
    userId: number,
    context: string,
    prompt: string
  ): Promise<string> {
    const inputHash = crypto.createHash("sha256").update(prompt).digest("hex");
    let response = "";

    if ((this.provider === "openai" || this.provider === "deepseek") && this.openaiClient) {
      const completion = await this.openaiClient.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: "system",
            content:
              "You are a Stacks blockchain trading bot. Respond only in valid JSON.",
          },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        ...(this.provider === "openai" ? { response_format: { type: "json_object" as const } } : {}),
      });

      response = completion.choices[0]?.message?.content ?? "";
      await this.saveRecommendation(userId, context, inputHash, {
        provider: this.provider,
        model: this.model,
        promptTokens: completion.usage?.prompt_tokens ?? 0,
        completionTokens: completion.usage?.completion_tokens ?? 0,
        response,
      });
    } else if (this.provider === "google" && this.googleClient) {
      const model = this.googleClient.getGenerativeModel({
        model: this.model,
      });
      const result = await model.generateContent(prompt);
      response = result.response.text();

      await this.saveRecommendation(userId, context, inputHash, {
        provider: "google",
        model: this.model,
        promptTokens: 0,
        completionTokens: 0,
        response,
      });
    } else {
      throw new Error(
        `AI provider "${this.provider}" is not configured or no API key provided`
      );
    }

    return response;
  }

  private async saveRecommendation(
    userId: number,
    context: string,
    inputHash: string,
    data: {
      provider: string;
      model: string;
      promptTokens: number;
      completionTokens: number;
      response: string;
    }
  ): Promise<void> {
    try {
      await DatabaseService.getInstance().createAIRecommendation({
        userId,
        context,
        inputHash,
        modelProvider: data.provider,
        modelName: data.model,
        promptTokens: data.promptTokens,
        completionTokens: data.completionTokens,
        recommendation: JSON.parse(extractJson(data.response)),
      });
    } catch {
      logger.warn("Failed to save AI recommendation", {
        context,
        provider: data.provider,
      });
    }
  }

  private parseSentimentResponse(response: string): AISentimentResult {
    try {
      const parsed = JSON.parse(extractJson(response));
      return {
        overallSentiment: parsed.overallSentiment ?? "NEUTRAL",
        confidence: parsed.confidence ?? 0.5,
        reasoning: parsed.reasoning ?? "",
        timestamp: new Date(),
      };
    } catch {
      logger.warn("Failed to parse sentiment response, using default");
      return {
        overallSentiment: "NEUTRAL",
        confidence: 0.3,
        reasoning: "Failed to parse AI response",
        timestamp: new Date(),
      };
    }
  }

  private parsePortfolioResponse(
    response: string,
    balances: TokenBalance[]
  ): PortfolioTarget[] {
    try {
      const parsed = JSON.parse(extractJson(response));
      const targets: PortfolioTarget[] = parsed.targets ?? [];

      if (targets.length === 0) {
        return this.equalWeightTargets(balances);
      }

      const totalWeight = targets.reduce(
        (sum, t) => sum + (t.targetWeight ?? 0),
        0
      );

      if (Math.abs(totalWeight - 1.0) > 0.01) {
        logger.warn("Portfolio weights don't sum to 1.0, normalizing");
        return targets.map((t) => ({
          token: t.token,
          targetWeight: t.targetWeight / totalWeight,
        }));
      }

      return targets;
    } catch {
      logger.warn("Failed to parse portfolio response, using equal weights");
      return this.equalWeightTargets(balances);
    }
  }

  private parseGridResponse(
    response: string,
    tokenPair: string,
    midPrice: number
  ): GridSpreadConfig {
    try {
      const parsed = JSON.parse(extractJson(response));
      return {
        tokenPair,
        midPrice,
        levels: Math.min(10, Math.max(3, parsed.levels ?? 5)),
        spreadBps: Math.min(500, Math.max(10, parsed.spreadBps ?? 30)),
      };
    } catch {
      logger.warn("Failed to parse grid response, using defaults");
      return {
        tokenPair,
        midPrice,
        levels: 5,
        spreadBps: 30,
      };
    }
  }

  private equalWeightTargets(balances: TokenBalance[]): PortfolioTarget[] {
    if (balances.length === 0) return [];
    const weight = 1.0 / balances.length;
    return balances.map((b) => ({ token: b.symbol, targetWeight: weight }));
  }
}

function extractJson(text: string): string {
  let cleaned = text.trim();
  // Strip markdown code fences
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  // Find first { and last }
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end !== -1 && end > start) {
    return cleaned.slice(start, end + 1);
  }
  return cleaned;
}
