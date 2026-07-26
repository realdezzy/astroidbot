import {
  createPublicClient,
  http,
  encodeFunctionData,
  isAddress,
  parseUnits,
  formatUnits,
  type Address,
  type PublicClient,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import { ConfigManager } from "../../../config.js";
import { logger } from "../../../utils/logger.js";
import type { SwappableToken, TransactionPayload } from "../../../types.js";
import type { DEXProvider, DEXQuote, TradingPair } from "../../../types/dexProvider.js";
import { ERC20_ABI, UNISWAP_V3_QUOTER_V2_ABI, UNISWAP_V3_ROUTER_ABI } from "../../chains/evm/abis.js";
import { CircuitBreakerRegistry } from "../../../utils/circuitBreaker.js";
import { toDecimalString } from "../../../utils/decimal.js";

// Canonical Base mainnet deployments (Uniswap V3).
const MAINNET_TOKENS: SwappableToken[] = [
  { contractId: "0x4200000000000000000000000000000000000006", symbol: "WETH", name: "Wrapped Ether", decimals: 18 },
  { contractId: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", symbol: "USDC", name: "USD Coin", decimals: 6 },
  { contractId: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", symbol: "DAI", name: "Dai Stablecoin", decimals: 18 },
];
const MAINNET_QUOTER: Address = "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a";
const MAINNET_ROUTER: Address = "0x2626664c2603336E57B271c5C0b26F421741e481";

// Base Sepolia testnet deployments.
const SEPOLIA_TOKENS: SwappableToken[] = [
  { contractId: "0x4200000000000000000000000000000000000006", symbol: "WETH", name: "Wrapped Ether", decimals: 18 },
  { contractId: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", symbol: "USDC", name: "USD Coin", decimals: 6 },
];
const SEPOLIA_QUOTER: Address = "0xC5290058841028F1614F3A6F0F5816cAd0df5E27";
const SEPOLIA_ROUTER: Address = "0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4";

// Standard Uniswap V3 fee tiers (hundredths of a bip), tried in order until
// one has a live pool for the pair — no factory-existence lookup, so this
// costs one extra simulateContract call per fee-tier miss.
const FEE_TIERS = [500, 3000, 10000] as const;

// Quotes are RPC-expensive (one simulateContract per fee tier until a hit), and
// getQuote needs two extra token prices just to compute price impact. Prices are
// cached briefly so a single getBestQuote doesn't fan out into ~10 round-trips
// against a rate-limited public RPC. Short enough that a quote never prices off
// meaningfully stale data.
const PRICE_CACHE_TTL_MS = 15_000;

// Every address this provider sends calls to. A malformed constant would
// otherwise surface as viem throwing inside quoteRaw's per-fee-tier catch,
// i.e. as a silent "no route found" on every pair — validated at registration
// instead so a typo fails loudly the moment Base support is switched on.
function assertValidAddresses(label: string, addresses: string[]): void {
  const invalid = addresses.filter((a) => !isAddress(a, { strict: false }));
  if (invalid.length > 0) {
    throw new Error(
      `UniswapV3BaseProvider: invalid ${label} address constant(s): ${invalid.join(", ")}`
    );
  }
}

// Uniswap V3 on Base — first non-Stacks DEXProvider. Only ERC-20-to-ERC-20
// swaps are supported (native ETH input/output would need WETH
// wrap/unwrap handling, not implemented yet — trade WETH directly instead).
export class UniswapV3BaseProvider implements DEXProvider {
  name = "UniswapV3Base";
  chainFamily = "evm";
  private static instance: UniswapV3BaseProvider;
  private priceCache = new Map<string, { price: number; at: number }>();
  // Remembers which fee tier actually had a pool for a pair, so the common
  // hasRoute-then-getQuote sequence doesn't re-probe the missing tiers each
  // time. Pool existence per tier doesn't change, so this needs no TTL.
  private feeTierCache = new Map<string, number>();

  private constructor() { }

  private get breaker() {
    return CircuitBreakerRegistry.getBreaker("UniswapV3Base");
  }

  static initialize(): UniswapV3BaseProvider {
    if (!UniswapV3BaseProvider.instance) {
      assertValidAddresses("mainnet", [
        MAINNET_QUOTER,
        MAINNET_ROUTER,
        ...MAINNET_TOKENS.map((t) => t.contractId),
      ]);
      assertValidAddresses("sepolia", [
        SEPOLIA_QUOTER,
        SEPOLIA_ROUTER,
        ...SEPOLIA_TOKENS.map((t) => t.contractId),
      ]);
      UniswapV3BaseProvider.instance = new UniswapV3BaseProvider();
    }
    return UniswapV3BaseProvider.instance;
  }

  static getInstance(): UniswapV3BaseProvider {
    if (!UniswapV3BaseProvider.instance) {
      throw new Error("UniswapV3BaseProvider not initialized. Call initialize() first.");
    }
    return UniswapV3BaseProvider.instance;
  }

  private isMainnet(): boolean {
    return ConfigManager.getInstance().config.BASE_NETWORK === "mainnet";
  }

  private chain() {
    return this.isMainnet() ? base : baseSepolia;
  }

  private tokens(): SwappableToken[] {
    return this.isMainnet() ? MAINNET_TOKENS : SEPOLIA_TOKENS;
  }

  private quoterAddress(): Address {
    return this.isMainnet() ? MAINNET_QUOTER : SEPOLIA_QUOTER;
  }

  private routerAddress(): Address {
    return this.isMainnet() ? MAINNET_ROUTER : SEPOLIA_ROUTER;
  }

  private publicClient(): PublicClient {
    const rpcUrl = ConfigManager.getInstance().config.BASE_RPC_URL || this.chain().rpcUrls.default.http[0]!;
    return createPublicClient({ chain: this.chain(), transport: http(rpcUrl) }) as PublicClient;
  }

  private resolveToken(symbolOrAddress: string): SwappableToken | null {
    const needle = symbolOrAddress.toLowerCase();
    const known = this.tokens().find(
      (t) => t.symbol.toLowerCase() === needle || t.contractId.toLowerCase() === needle
    );
    if (known) return known;
    // Unknown ERC-20 address — assume 18 decimals (most common); callers
    // passing a symbol we don't recognize will correctly fail to resolve.
    if (symbolOrAddress.startsWith("0x") && symbolOrAddress.length === 42) {
      return { contractId: symbolOrAddress, symbol: symbolOrAddress, name: symbolOrAddress, decimals: 18 };
    }
    return null;
  }

  async getSwappableTokens(_refresh = false): Promise<SwappableToken[]> {
    return this.tokens();
  }

  getCachedTokens(): SwappableToken[] {
    return this.tokens();
  }

  getTradingPairs(): TradingPair[] {
    // Static curated token set — no live pool reserve fetching implemented yet.
    return [];
  }

  private async quoteRaw(
    tokenIn: SwappableToken,
    tokenOut: SwappableToken,
    amountInRaw: bigint
  ): Promise<{ amountOut: bigint; fee: number } | null> {
    const client = this.publicClient();
    const pairKey = `${tokenIn.contractId.toLowerCase()}:${tokenOut.contractId.toLowerCase()}`;
    const knownFee = this.feeTierCache.get(pairKey);
    const tiers = knownFee !== undefined
      ? [knownFee, ...FEE_TIERS.filter((f) => f !== knownFee)]
      : [...FEE_TIERS];

    for (const fee of tiers) {
      try {
        const { result } = await this.breaker.execute(() =>
          client.simulateContract({
            address: this.quoterAddress(),
            abi: UNISWAP_V3_QUOTER_V2_ABI,
            functionName: "quoteExactInputSingle",
            args: [
              {
                tokenIn: tokenIn.contractId as Address,
                tokenOut: tokenOut.contractId as Address,
                amountIn: amountInRaw,
                fee,
                sqrtPriceLimitX96: 0n,
              },
            ],
          })
        );
        const [amountOut] = result as readonly [bigint, bigint, number, bigint];
        if (amountOut > 0n) {
          this.feeTierCache.set(pairKey, fee);
          return { amountOut, fee };
        }
      } catch {
        // No pool at this fee tier (or insufficient liquidity) — try the next.
      }
    }
    return null;
  }

  async hasRoute(tokenIn: string, tokenOut: string): Promise<boolean> {
    const tIn = this.resolveToken(tokenIn);
    const tOut = this.resolveToken(tokenOut);
    if (!tIn || !tOut) return false;
    const probe = parseUnits("1", tIn.decimals);
    const result = await this.quoteRaw(tIn, tOut, probe);
    return result !== null;
  }

  async getTokenPrice(tokenSymbol: string): Promise<number> {
    const token = this.resolveToken(tokenSymbol);
    const usdc = this.tokens().find((t) => t.symbol === "USDC");
    if (!token || !usdc) return 0;
    if (token.contractId.toLowerCase() === usdc.contractId.toLowerCase()) return 1;

    const cacheKey = token.contractId.toLowerCase();
    const cached = this.priceCache.get(cacheKey);
    if (cached && Date.now() - cached.at < PRICE_CACHE_TTL_MS) {
      return cached.price;
    }

    try {
      const probe = parseUnits("1", token.decimals);
      const result = await this.quoteRaw(token, usdc, probe);
      if (!result) return 0;
      const price = Number(formatUnits(result.amountOut, usdc.decimals));
      this.priceCache.set(cacheKey, { price, at: Date.now() });
      return price;
    } catch {
      return 0;
    }
  }

  async getQuote(tokenIn: string, tokenOut: string, amountIn: number): Promise<DEXQuote> {
    const tIn = this.resolveToken(tokenIn);
    const tOut = this.resolveToken(tokenOut);
    if (!tIn || !tOut || amountIn <= 0) {
      return { amountOut: 0, priceImpact: 0, feeBps: 0, feeAmount: 0 };
    }

    try {
      const amountInRaw = parseUnits(toDecimalString(amountIn), tIn.decimals);
      const result = await this.quoteRaw(tIn, tOut, amountInRaw);
      if (!result) return { amountOut: 0, priceImpact: 0, feeBps: 0, feeAmount: 0 };

      const amountOut = Number(formatUnits(result.amountOut, tOut.decimals));
      // Uniswap fee is in hundredths of a bip (1e-6 of amountIn); bps is 1e-4.
      const feeBps = result.fee / 100;
      const feeAmount = amountIn * (result.fee / 1_000_000);

      const [priceIn, priceOut] = await Promise.all([
        this.getTokenPrice(tokenIn),
        this.getTokenPrice(tokenOut),
      ]);
      let priceImpact = 0;
      if (priceIn > 0 && priceOut > 0 && amountOut > 0) {
        const spotPrice = priceIn / priceOut;
        const executionPrice = amountIn / amountOut;
        priceImpact = Math.abs(1 - executionPrice / spotPrice) * 100;
      }

      return { amountOut, priceImpact: Math.round(priceImpact * 100) / 100, feeBps, feeAmount };
    } catch (err) {
      logger.warn("UniswapV3BaseProvider getQuote failed", {
        tokenIn,
        tokenOut,
        amountIn,
        error: err instanceof Error ? err.message : String(err),
      });
      return { amountOut: 0, priceImpact: 0, feeBps: 0, feeAmount: 0 };
    }
  }

  async buildSwapPayload(
    tokenIn: string,
    tokenOut: string,
    amountIn: number,
    minAmountOut: number,
    senderAddress: string
  ): Promise<TransactionPayload | null> {
    const tIn = this.resolveToken(tokenIn);
    const tOut = this.resolveToken(tokenOut);
    if (!tIn || !tOut) return null;

    try {
      const amountInRaw = parseUnits(toDecimalString(amountIn), tIn.decimals);
      const result = await this.quoteRaw(tIn, tOut, amountInRaw);
      if (!result) return null;

      const amountOutMinimumRaw = parseUnits(toDecimalString(minAmountOut), tOut.decimals);
      const router = this.routerAddress();

      const swapData = encodeFunctionData({
        abi: UNISWAP_V3_ROUTER_ABI,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: tIn.contractId as Address,
            tokenOut: tOut.contractId as Address,
            fee: result.fee,
            recipient: senderAddress as Address,
            amountIn: amountInRaw,
            amountOutMinimum: amountOutMinimumRaw,
            sqrtPriceLimitX96: 0n,
          },
        ],
      });

      const calls: { to: string; data: string; value?: string }[] = [];

      // Only include the approval call if the smart account's current
      // allowance to the router is insufficient — avoids a redundant
      // approve on every swap once one large approval has gone through.
      const currentAllowance = await this.breaker
        .execute(() =>
          this.publicClient().readContract({
            address: tIn.contractId as Address,
            abi: ERC20_ABI,
            functionName: "allowance",
            args: [senderAddress as Address, router],
          })
        )
        .catch(() => 0n);

      if (currentAllowance < amountInRaw) {
        const approveData = encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [router, amountInRaw],
        });
        calls.push({ to: tIn.contractId, data: approveData });
      }

      calls.push({ to: router, data: swapData, value: "0" });

      return { kind: "evm", calls };
    } catch (err) {
      logger.warn("UniswapV3BaseProvider buildSwapPayload failed", {
        tokenIn,
        tokenOut,
        amountIn,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
