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
import { ERC20_ABI, UNISWAP_V3_QUOTER_V2_ABI, UNISWAP_V3_ROUTER_ABI } from "../../chains/evm/abis.js";
import { CircuitBreakerRegistry } from "../../../utils/circuitBreaker.js";
import { toDecimalString } from "../../../utils/decimal.js";
import { BaseDEXProvider } from "./baseDexProvider.js";
import { requireEvmConfig, type ChainDescriptor } from "../../../types/chain.js";

/**
 * Uniswap V3 and its forks, on any EVM chain.
 *
 * The QuoterV2 fee-tier scan, exactInputSingle payload building and
 * allowance-aware approve batching are identical for every V3 deployment —
 * only addresses and the token list differ, and those live in the chain's
 * descriptor. Base, Celo (Ubeswap) and any V3 fork declared through
 * CUSTOM_EVM_CHAINS share this one implementation.
 *
 * Only ERC-20-to-ERC-20 swaps are handled here; native-asset input/output is
 * wrapped by the caller (see EvmChainAdapter's wrap/unwrap support).
 */
export class UniswapV3Provider extends BaseDEXProvider {
  readonly name: string;
  private readonly evm: ReturnType<typeof requireEvmConfig>;
  private readonly tokenList: SwappableToken[];

  // Remembers which fee tier actually had a pool for a pair, so the common
  // hasRoute-then-getQuote sequence doesn't re-probe the missing tiers each
  // time. Pool existence per tier doesn't change, so this needs no TTL.
  private feeTierCache = new Map<string, number>();

  constructor(descriptor: ChainDescriptor) {
    super(descriptor);
    this.evm = requireEvmConfig(descriptor);

    if (!this.evm.dex) {
      throw new Error(
        `Chain ${descriptor.chainId} has no DEX configured — it cannot back a UniswapV3Provider`
      );
    }

    // Name is per-chain so DEXRegistry (which dedupes by name) can hold a
    // provider for every chain simultaneously. A shared "UniswapV3" name would
    // mean the second chain's provider is silently dropped at registration —
    // the same class of bug as the family-keyed adapter registry.
    this.name = `${this.evm.dex.name}-${descriptor.chainId}`;

    this.tokenList = Object.entries(this.evm.tokens ?? {}).map(([symbol, t]) => ({
      contractId: t.address,
      symbol,
      name: t.name,
      decimals: t.decimals,
      chainFamily: descriptor.family,
      chainId: descriptor.chainId,
    }));
  }

  private get dex() {
    return this.evm.dex!;
  }

  private get breaker() {
    return CircuitBreakerRegistry.getBreaker(this.name);
  }

  private rpcUrl(): string {
    const key = `RPC_URL_${this.descriptor.chainId.toUpperCase().replace(/[:-]/g, "_")}`;
    return process.env[key] || this.evm.defaultRpcUrl;
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

  private resolveToken(symbolOrAddress: string): SwappableToken | null {
    const needle = symbolOrAddress.toLowerCase();
    const known = this.tokenList.find(
      (t) => t.symbol.toLowerCase() === needle || t.contractId.toLowerCase() === needle
    );
    if (known) return known;
    // Unknown ERC-20 address — assume the chain's native decimals (18 on every
    // EVM chain). A symbol we don't recognise correctly fails to resolve.
    if (symbolOrAddress.startsWith("0x") && symbolOrAddress.length === 42) {
      return {
        contractId: symbolOrAddress,
        symbol: symbolOrAddress,
        name: symbolOrAddress,
        decimals: this.descriptor.nativeDecimals,
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
  ): Promise<{ amountOut: bigint; fee: number } | null> {
    const client = this.publicClient();
    const pairKey = `${tokenIn.contractId.toLowerCase()}:${tokenOut.contractId.toLowerCase()}`;
    const knownFee = this.feeTierCache.get(pairKey);
    const tiers =
      knownFee !== undefined
        ? [knownFee, ...this.dex.feeTiers.filter((f) => f !== knownFee)]
        : [...this.dex.feeTiers];

    for (const fee of tiers) {
      try {
        const { result } = await this.breaker.execute(() =>
          client.simulateContract({
            address: this.dex.quoter,
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
    return (await this.quoteRaw(tIn, tOut, probe)) !== null;
  }

  async getTokenPrice(tokenSymbol: string): Promise<number> {
    const token = this.resolveToken(tokenSymbol);
    const stable = this.tokenList.find((t) => t.symbol === this.descriptor.stableSymbol);
    if (!token || !stable) return 0;
    if (token.contractId.toLowerCase() === stable.contractId.toLowerCase()) return 1;

    const cacheKey = token.contractId.toLowerCase();
    const cached = this.cachedPrice(cacheKey);
    if (cached !== undefined) return cached;

    try {
      const probe = parseUnits("1", token.decimals);
      const result = await this.quoteRaw(token, stable, probe);
      if (!result) return 0;
      return this.cachePrice(cacheKey, Number(formatUnits(result.amountOut, stable.decimals)));
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
      logger.warn(`${this.name} getQuote failed`, {
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
      const router = this.dex.swapRouter;

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

      // Only include the approval call if the account's current allowance to
      // the router is insufficient — avoids a redundant approve on every swap
      // once one large approval has gone through.
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
