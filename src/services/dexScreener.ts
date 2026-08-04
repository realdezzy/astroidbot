import axios from "axios";
import { logger } from "../utils/logger.js";

export interface DexScreenerPair {
  chainId: string;
  dexId: string;
  url: string;
  pairAddress: string;
  baseToken: {
    address: string;
    name: string;
    symbol: string;
  };
  quoteToken: {
    address: string;
    name: string;
    symbol: string;
  };
  priceNative: string;
  priceUsd: string;
  txns?: {
    m5?: { buys: number; sells: number };
    h1?: { buys: number; sells: number };
    h6?: { buys: number; sells: number };
    h24?: { buys: number; sells: number };
  };
  volume?: {
    m5?: number;
    h1?: number;
    h6?: number;
    h24?: number;
  };
  priceChange?: {
    m5?: number;
    h1?: number;
    h6?: number;
    h24?: number;
  };
  liquidity?: {
    usd?: number;
    base?: number;
    quote?: number;
  };
  fdv?: number;
  marketCap?: number;
  pairCreatedAt?: number;
  info?: {
    imageUrl?: string;
    header?: string;
    openGraph?: string;
  };
}

export class DexScreenerService {
  private static instance: DexScreenerService;
  private cache: Map<string, { data: DexScreenerPair[]; timestamp: number }> = new Map();
  private CACHE_TTL_MS = 60_000; // 1 minute cache

  static getInstance(): DexScreenerService {
    if (!DexScreenerService.instance) {
      DexScreenerService.instance = new DexScreenerService();
    }
    return DexScreenerService.instance;
  }

  async getPairsForTokens(addresses: string[]): Promise<DexScreenerPair[]> {
    if (addresses.length === 0) return [];
    
    // DexScreener endpoint accepts at most 30 token addresses per call.
    if (addresses.length > 30) {
      const chunks: string[][] = [];
      for (let i = 0; i < addresses.length; i += 30) {
        chunks.push(addresses.slice(i, i + 30));
      }
      const results = await Promise.all(chunks.map((chunk) => this.getPairsForTokens(chunk)));
      return results.flat();
    }

    const key = [...addresses].sort().join(",");
    const cached = this.cache.get(key);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
      return cached.data;
    }

    try {
      const url = `https://api.dexscreener.com/latest/dex/tokens/${addresses.join(",")}`;
      const response = await axios.get<{ pairs: DexScreenerPair[] }>(url, { timeout: 5000 });
      const pairs = response.data?.pairs || [];
      this.cache.set(key, { data: pairs, timestamp: Date.now() });
      return pairs;
    } catch (error) {
      logger.warn("DexScreener API fetch failed, returning cached or empty array", {
        error: error instanceof Error ? error.message : String(error),
      });
      return cached?.data || [];
    }
  }

  async searchPairs(query: string): Promise<DexScreenerPair[]> {
    try {
      const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;
      const response = await axios.get<{ pairs: DexScreenerPair[] }>(url, { timeout: 5000 });
      return response.data?.pairs || [];
    } catch (error) {
      logger.warn("DexScreener search failed", {
        query,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  getBestPairForToken(pairs: DexScreenerPair[], contractOrSymbol: string): DexScreenerPair | undefined {
    const target = contractOrSymbol.toLowerCase();
    const matching = pairs.filter(
      (p) =>
        p.baseToken?.address?.toLowerCase() === target ||
        p.quoteToken?.address?.toLowerCase() === target ||
        p.baseToken?.symbol?.toLowerCase() === target ||
        p.quoteToken?.symbol?.toLowerCase() === target
    );

    const first = matching[0];
    if (!first) return undefined;

    return matching.reduce((prev, curr) => {
      const prevLiq = prev.liquidity?.usd || 0;
      const currLiq = curr.liquidity?.usd || 0;
      return currLiq > prevLiq ? curr : prev;
    }, first);
  }
}


