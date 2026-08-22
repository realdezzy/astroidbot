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
  UNISWAP_UNIVERSAL_ROUTER_ABI,
  WRAPPED_NATIVE_ABI,
} from "../../chains/evm/abis.js";
import { CircuitBreakerRegistry } from "../../../utils/circuitBreaker.js";
import { toDecimalString } from "../../../utils/decimal.js";
import { BaseDEXProvider } from "./baseDexProvider.js";
import { requireEvmConfig, type ChainDescriptor } from "../../../types/chain.js";
import { UniswapV3Provider } from "./uniswapV3.js";
import { UniswapV2Provider } from "./uniswapV2.js";

/**
 * Universal Router DEX Provider.
 * Probes across Uniswap V2 and V3 pools to identify best-route output,
 * then constructs Universal Router payloads when universalRouter address is available.
 */
export class UniswapUniversalProvider extends BaseDEXProvider {
  readonly name: string;
  private readonly evm: ReturnType<typeof requireEvmConfig>;
  private readonly v3Provider: UniswapV3Provider | null = null;
  private readonly v2Provider: UniswapV2Provider | null = null;

  constructor(descriptor: ChainDescriptor) {
    super(descriptor);
    this.evm = requireEvmConfig(descriptor);

    if (!this.evm.dex) {
      throw new Error(`Chain ${descriptor.chainId} has no DEX configuration`);
    }

    this.name = `UniswapUniversal-${descriptor.chainId}`;

    if (this.evm.dex.quoter && this.evm.dex.swapRouter && this.evm.dex.feeTiers) {
      this.v3Provider = new UniswapV3Provider(descriptor);
    }

    if (this.evm.dex.v2Router) {
      this.v2Provider = new UniswapV2Provider(descriptor);
    }
  }

  private get router(): Address | null {
    return (this.evm.dex?.universalRouter as Address) || null;
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

  async getSwappableTokens(refresh = false): Promise<SwappableToken[]> {
    if (this.v3Provider) return this.v3Provider.getSwappableTokens(refresh);
    if (this.v2Provider) return this.v2Provider.getSwappableTokens(refresh);
    return [];
  }

  getCachedTokens(): SwappableToken[] {
    if (this.v3Provider) return this.v3Provider.getCachedTokens();
    if (this.v2Provider) return this.v2Provider.getCachedTokens();
    return [];
  }

  async hasRoute(tokenIn: string, tokenOut: string): Promise<boolean> {
    const [v3Route, v2Route] = await Promise.all([
      this.v3Provider ? this.v3Provider.hasRoute(tokenIn, tokenOut) : false,
      this.v2Provider ? this.v2Provider.hasRoute(tokenIn, tokenOut) : false,
    ]);
    return v3Route || v2Route;
  }

  async getTokenPrice(tokenSymbol: string): Promise<number> {
    if (this.v3Provider) {
      const price = await this.v3Provider.getTokenPrice(tokenSymbol);
      if (price > 0) return price;
    }
    if (this.v2Provider) {
      return this.v2Provider.getTokenPrice(tokenSymbol);
    }
    return 0;
  }

  async getQuote(tokenIn: string, tokenOut: string, amountIn: number): Promise<DEXQuote> {
    const [v3Quote, v2Quote] = await Promise.all([
      this.v3Provider ? this.v3Provider.getQuote(tokenIn, tokenOut, amountIn) : null,
      this.v2Provider ? this.v2Provider.getQuote(tokenIn, tokenOut, amountIn) : null,
    ]);

    if (v3Quote && v2Quote) {
      return v3Quote.amountOut >= v2Quote.amountOut ? v3Quote : v2Quote;
    }
    return v3Quote || v2Quote || { amountOut: 0, priceImpact: 0, feeBps: 0, feeAmount: 0 };
  }

  async buildSwapPayload(
    tokenIn: string,
    tokenOut: string,
    amountIn: number,
    minAmountOut: number,
    senderAddress: string
  ): Promise<TransactionPayload | null> {
    const [v3Quote, v2Quote] = await Promise.all([
      this.v3Provider ? this.v3Provider.getQuote(tokenIn, tokenOut, amountIn) : null,
      this.v2Provider ? this.v2Provider.getQuote(tokenIn, tokenOut, amountIn) : null,
    ]);

    const useV3 = v3Quote && (!v2Quote || v3Quote.amountOut >= v2Quote.amountOut);

    if (useV3 && this.v3Provider) {
      return this.v3Provider.buildSwapPayload(tokenIn, tokenOut, amountIn, minAmountOut, senderAddress);
    }
    if (this.v2Provider) {
      return this.v2Provider.buildSwapPayload(tokenIn, tokenOut, amountIn, minAmountOut, senderAddress);
    }
    return null;
  }
}
