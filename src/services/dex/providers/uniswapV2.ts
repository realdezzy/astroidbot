import {
  createPublicClient,
  defineChain,
  http,
  encodeFunctionData,
  parseUnits,
  formatUnits,
  type Address,
  type PublicClient,
} from "viem";
import { logger } from "../../../utils/logger.js";
import type { SwappableToken, TransactionPayload } from "../../../types.js";
import type { DEXQuote } from "../../../types/dexProvider.js";
import {
  ERC20_ABI,
  UNISWAP_V2_ROUTER_ABI,
  WRAPPED_NATIVE_ABI,
} from "../../chains/evm/abis.js";
import { CircuitBreakerRegistry } from "../../../utils/circuitBreaker.js";
import { toDecimalString } from "../../../utils/decimal.js";
import { BaseDEXProvider } from "./baseDexProvider.js";
import { requireEvmConfig, type ChainDescriptor } from "../../../types/chain.js";
import { rpcUrlOverride } from "../../chains/evm/evmClient.js";

/**
 * Uniswap V2 and constant-product AMM forks (e.g. PancakeSwap, Sushiswap, Ubeswap V2).
 * Handles fixed 0.30% fee constant product pools via UniswapV2Router02.
 */
export class UniswapV2Provider extends BaseDEXProvider {
  readonly name: string;
  private readonly evm: ReturnType<typeof requireEvmConfig>;
  private readonly tokenList: SwappableToken[];
  private decimalsCache = new Map<string, number>();

  constructor(descriptor: ChainDescriptor) {
    super(descriptor);
    this.evm = requireEvmConfig(descriptor);

    if (!this.evm.dex?.v2Router) {
      throw new Error(
        `Chain ${descriptor.chainId} has no V2 DEX router configured`
      );
    }

    this.name = `UniswapV2-${descriptor.chainId}`;

    this.tokenList = Object.entries(this.evm.tokens ?? {}).map(([symbol, t]) => ({
      contractId: t.address,
      symbol,
      name: t.name,
      decimals: t.decimals,
      chainFamily: descriptor.family,
      chainId: descriptor.chainId,
    }));
  }

  private get router(): Address {
    return this.evm.dex!.v2Router!;
  }

  private get breaker() {
    return CircuitBreakerRegistry.getBreaker(this.name);
  }

  private rpcUrl(): string {
    return rpcUrlOverride(this.descriptor.chainId, this.evm.defaultRpcUrl);
  }

  private publicClient(): PublicClient {
    const chain = defineChain({
      id: this.evm.id,
      name: this.descriptor.displayName,
      nativeCurrency: {
        name: this.descriptor.nativeSymbol,
        symbol: this.descriptor.nativeSymbol,
        decimals: this.descriptor.nativeDecimals,
      },
      rpcUrls: { default: { http: [this.rpcUrl()] } },
      testnet: this.descriptor.isTestnet,
    });
    return createPublicClient({ chain, transport: http(this.rpcUrl()) }) as PublicClient;
  }

  private isNative(symbolOrAddress: string): boolean {
    return symbolOrAddress.toUpperCase() === this.descriptor.nativeSymbol.toUpperCase();
  }

  private async fetchDecimals(address: string): Promise<number | null> {
    const key = address.toLowerCase();
    const cached = this.decimalsCache.get(key);
    if (cached !== undefined) return cached;

    try {
      const raw = await this.publicClient().readContract({
        address: key as Address,
        abi: ERC20_ABI,
        functionName: "decimals",
      });

      const decimals = Number(raw);
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) return null;

      this.decimalsCache.set(key, decimals);
      return decimals;
    } catch {
      return null;
    }
  }

  private async resolveToken(symbolOrAddress: string): Promise<SwappableToken | null> {
    if (this.isNative(symbolOrAddress) && this.evm.wrappedNative) {
      return {
        contractId: this.evm.wrappedNative,
        symbol: this.descriptor.nativeSymbol,
        name: `Wrapped ${this.descriptor.nativeSymbol}`,
        decimals: this.descriptor.nativeDecimals,
        chainFamily: this.descriptor.family,
        chainId: this.descriptor.chainId,
      };
    }

    const needle = symbolOrAddress.toLowerCase();
    const known = this.tokenList.find(
      (t) => t.symbol.toLowerCase() === needle || t.contractId.toLowerCase() === needle
    );
    if (known) return known;

    if (symbolOrAddress.startsWith("0x") && symbolOrAddress.length === 42) {
      const decimals = await this.fetchDecimals(symbolOrAddress);
      if (decimals === null) return null;

      return {
        contractId: symbolOrAddress,
        symbol: symbolOrAddress,
        name: symbolOrAddress,
        decimals,
        chainFamily: this.descriptor.family,
        chainId: this.descriptor.chainId,
      };
    }
    return null;
  }

  async getSwappableTokens(_refresh = false): Promise<SwappableToken[]> {
    return this.tokenList;
  }

  getCachedTokens(): SwappableToken[] {
    return this.tokenList;
  }

  private async quoteRaw(
    tokenIn: SwappableToken,
    tokenOut: SwappableToken,
    amountInRaw: bigint
  ): Promise<bigint | null> {
    const client = this.publicClient();
    const path: [Address, Address] = [
      tokenIn.contractId as Address,
      tokenOut.contractId as Address,
    ];

    try {
      const amounts = (await this.breaker.execute(() =>
        client.readContract({
          address: this.router,
          abi: UNISWAP_V2_ROUTER_ABI,
          functionName: "getAmountsOut",
          args: [amountInRaw, path],
        })
      )) as readonly bigint[];
      if (amounts && amounts.length >= 2 && amounts[1] !== undefined && amounts[1] > 0n) {
        return amounts[1];
      }
    } catch {
      // Pair does not exist or has zero liquidity
    }
    return null;
  }

  async hasRoute(tokenIn: string, tokenOut: string): Promise<boolean> {
    const [tIn, tOut] = await Promise.all([
      this.resolveToken(tokenIn),
      this.resolveToken(tokenOut),
    ]);
    if (!tIn || !tOut) return false;
    const probe = parseUnits("1", tIn.decimals);
    return (await this.quoteRaw(tIn, tOut, probe)) !== null;
  }

  async getTokenPrice(tokenSymbol: string): Promise<number> {
    const token = await this.resolveToken(tokenSymbol);
    const stable = this.tokenList.find((t) => t.symbol === this.descriptor.stableSymbol);
    if (!token || !stable) return 0;
    if (token.contractId.toLowerCase() === stable.contractId.toLowerCase()) return 1;

    const cacheKey = token.contractId.toLowerCase();
    const cached = this.cachedPrice(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const probe = parseUnits("1", token.decimals);
      const amountOut = await this.quoteRaw(token, stable, probe);
      if (!amountOut) return 0;
      return this.cachePrice(cacheKey, Number(formatUnits(amountOut, stable.decimals)));
    } catch {
      return 0;
    }
  }

  async getQuote(tokenIn: string, tokenOut: string, amountIn: number): Promise<DEXQuote> {
    const [tIn, tOut] = await Promise.all([
      this.resolveToken(tokenIn),
      this.resolveToken(tokenOut),
    ]);
    if (!tIn || !tOut || amountIn <= 0) {
      return { amountOut: 0, priceImpact: 0, feeBps: 30, feeAmount: 0 };
    }

    try {
      const amountInRaw = parseUnits(toDecimalString(amountIn), tIn.decimals);
      const amountOutRaw = await this.quoteRaw(tIn, tOut, amountInRaw);
      if (!amountOutRaw) return { amountOut: 0, priceImpact: 0, feeBps: 30, feeAmount: 0 };

      const amountOut = Number(formatUnits(amountOutRaw, tOut.decimals));
      const feeBps = 30; // Uniswap V2 standard 0.3% fee
      const feeAmount = amountIn * 0.003;

      const [priceIn, priceOut] = await Promise.all([
        this.getTokenPrice(tokenIn),
        this.getTokenPrice(tokenOut),
      ]);
      let priceImpact = 0;
      if (priceIn > 0 && priceOut > 0 && amountOut > 0 && amountIn > 0) {
        const spotPrice = priceIn / priceOut;
        const executionPrice = amountOut / amountIn;
        priceImpact = Math.abs(1 - executionPrice / spotPrice) * 100;
      }

      return { amountOut, priceImpact: Math.round(priceImpact * 100) / 100, feeBps, feeAmount };
    } catch (err) {
      logger.warn(`${this.name} getQuote failed`, {
        tokenIn,
        tokenOut,
        amountIn,
        error: err instanceof Error ? err.message : String(err),
      });
      return { amountOut: 0, priceImpact: 0, feeBps: 30, feeAmount: 0 };
    }
  }

  async buildSwapPayload(
    tokenIn: string,
    tokenOut: string,
    amountIn: number,
    minAmountOut: number,
    senderAddress: string
  ): Promise<TransactionPayload | null> {
    const [tIn, tOut] = await Promise.all([
      this.resolveToken(tokenIn),
      this.resolveToken(tokenOut),
    ]);
    if (!tIn || !tOut) return null;

    try {
      const amountInRaw = parseUnits(toDecimalString(amountIn), tIn.decimals);
      const amountOutMinimumRaw = parseUnits(toDecimalString(minAmountOut), tOut.decimals);

      const path: [Address, Address] = [
        tIn.contractId as Address,
        tOut.contractId as Address,
      ];

      // Set 20-minute expiration deadline
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);

      const swapData = encodeFunctionData({
        abi: UNISWAP_V2_ROUTER_ABI,
        functionName: "swapExactTokensForTokens",
        args: [
          amountInRaw,
          amountOutMinimumRaw,
          path,
          senderAddress as Address,
          deadline,
        ],
      });

      const calls: { to: string; data: string; value?: string }[] = [];

      const wrapsIn = this.isNative(tokenIn) && !!this.evm.wrappedNative;
      const unwrapsOut = this.isNative(tokenOut) && !!this.evm.wrappedNative;

      if (wrapsIn) {
        const depositData = encodeFunctionData({ abi: WRAPPED_NATIVE_ABI, functionName: "deposit" });
        calls.push({
          to: this.evm.wrappedNative!,
          data: depositData,
          value: amountInRaw.toString(),
        });
      }

      const currentAllowance = wrapsIn ? 0n : await this.breaker
        .execute(() =>
          this.publicClient().readContract({
            address: tIn.contractId as Address,
            abi: ERC20_ABI,
            functionName: "allowance",
            args: [senderAddress as Address, this.router],
          })
        )
        .catch(() => 0n);

      if (currentAllowance < amountInRaw) {
        const approveData = encodeFunctionData({
          abi: ERC20_ABI,
          functionName: "approve",
          args: [this.router, amountInRaw],
        });
        calls.push({ to: tIn.contractId, data: approveData });
      }

      calls.push({ to: this.router, data: swapData, value: "0" });

      if (unwrapsOut) {
        const withdrawData = encodeFunctionData({
          abi: WRAPPED_NATIVE_ABI,
          functionName: "withdraw",
          args: [amountOutMinimumRaw],
        });
        calls.push({ to: this.evm.wrappedNative!, data: withdrawData });
      }

      return { kind: "evm", calls };
    } catch (err) {
      logger.warn(`${this.name} buildSwapPayload failed`, {
        tokenIn,
        tokenOut,
        amountIn,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }
}
