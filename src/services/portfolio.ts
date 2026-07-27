import axios from "axios";
import { ConfigManager } from "../config.js";
import { logger } from "../utils/logger.js";
import { DEXRegistry } from "./dex/dexRegistry.js";
import { DatabaseService } from "./db.js";
import { createPublicClient, formatUnits, http } from "viem";
import { base, baseSepolia } from "viem/chains";
import { ERC20_ABI } from "./chains/evm/abis.js";
import { familyOfChainId } from "../types/chain.js";
import { ChainAdapterRegistry } from "./chains/chainAdapterRegistry.js";
import { DEFAULT_CHAIN_FOR_FAMILY } from "./chains/descriptors/index.js";
import type {
  PortfolioTarget,
  RebalanceAction,
  TokenBalance,
  SwappableToken,
} from "../types.js";

interface StacksBalance {
  stx: {
    balance: string;
    total_sent: string;
    total_received: string;
  };
  fungible_tokens: Record<string, { balance: string }>;
}

// Base58, 32-44 chars. Stacks principals are also base58-ish but always start
// with S, which is why the sniffing fallback excludes them explicitly.
const SOLANA_ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export class PortfolioManager {
  private static instance: PortfolioManager;
  private readonly dustThresholdUsd: number;

  private constructor() {
    this.dustThresholdUsd = ConfigManager.getInstance().config.DUST_THRESHOLD_USD;
  }

  static getInstance(): PortfolioManager {
    if (!PortfolioManager.instance) {
      PortfolioManager.instance = new PortfolioManager();
    }
    return PortfolioManager.instance;
  }

  /**
   * Native SOL plus SPL token balances.
   *
   * Uses getParsedTokenAccountsByOwner rather than one RPC call per mint: a
   * Solana wallet's token accounts are enumerable in a single request, which
   * is both faster and correct for tokens outside the curated list.
   */
  private async fetchSvmBalances(
    address: string,
    swappableTokens: SwappableToken[],
    ignoreDust: boolean,
    userId?: number,
    chainId?: string
  ): Promise<TokenBalance[]> {
    const registry = DEXRegistry.getInstance();
    const scope = chainId ?? DEFAULT_CHAIN_FOR_FAMILY.svm!;
    const adapters = ChainAdapterRegistry.getInstance();

    if (!adapters.has(scope)) {
      logger.warn("Cannot fetch Solana balances: chain not enabled", { chainId: scope });
      return [];
    }

    const adapter = adapters.get(scope) as unknown as {
      connection?: () => import("@solana/web3.js").Connection;
    };
    if (!adapter.connection) return [];

    let userBlockedSet = new Set<string>();
    if (userId) {
      try {
        const db = DatabaseService.getInstance();
        const userBlocked = await db.getBlockedTokens(userId);
        userBlockedSet = new Set(userBlocked.map((b) => b.contractId));
      } catch {
        // Blocked-token lookup failed; proceed without per-user blocking.
      }
    }
    const allowedTokens = ConfigManager.getInstance().allowedTokens;
    const blockedTokens = ConfigManager.getInstance().blockedTokens;

    const balances: TokenBalance[] = [];

    try {
      const { PublicKey } = await import("@solana/web3.js");
      const connection = adapter.connection();
      const owner = new PublicKey(address);

      const lamports = await connection.getBalance(owner);
      const solBalance = lamports / 1_000_000_000;

      if (solBalance > 0) {
        // No invented fallback price: this figure feeds RiskManager position
        // sizing, and a guessed price is worse than an unpriced balance.
        const solPrice = await registry.getTokenPrice("SOL", scope).catch(() => 0);
        const usdValue = solBalance * solPrice;
        if (ignoreDust || usdValue >= this.dustThresholdUsd) {
          balances.push({ token: "SOL", symbol: "SOL", balance: solBalance, usdValue });
        }
      }

      const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
      const accounts = await connection.getParsedTokenAccountsByOwner(owner, {
        programId: TOKEN_PROGRAM_ID,
      });

      const bySymbol = new Map(
        swappableTokens.map((t) => [t.contractId, t] as const)
      );

      interface ParsedTokenAccount {
        parsed?: { info?: { mint?: string; tokenAmount?: { uiAmount?: number } } };
      }

      for (const { account } of accounts.value) {
        const info = (account.data as ParsedTokenAccount).parsed?.info;
        if (!info?.mint) continue;

        const mint = info.mint;
        const amount = info.tokenAmount?.uiAmount ?? 0;
        if (amount <= 0) continue;

        if (allowedTokens.length > 0 && !allowedTokens.includes(mint)) continue;
        if (blockedTokens.length > 0 && blockedTokens.includes(mint)) continue;
        if (userBlockedSet.has(mint)) continue;

        const known = bySymbol.get(mint);
        const symbol = known?.symbol ?? mint;
        const price = await registry.getTokenPrice(symbol, scope).catch(() => 0);
        const usdValue = amount * price;

        if (!ignoreDust && usdValue < this.dustThresholdUsd) continue;

        balances.push({ token: mint, symbol, balance: amount, usdValue });
      }
    } catch (err) {
      logger.warn("Failed to fetch Solana balances", {
        address,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return balances;
  }

  private async fetchEvmBalances(
    address: string,
    swappableTokens: SwappableToken[],
    ignoreDust: boolean,
    userId?: number
  ): Promise<TokenBalance[]> {
    const config = ConfigManager.getInstance().config;
    const isMainnet = config.BASE_NETWORK === "mainnet";
    const chain = isMainnet ? base : baseSepolia;
    const rpcUrl = config.BASE_RPC_URL || chain.rpcUrls.default.http[0]!;

    const client = createPublicClient({
      chain,
      transport: http(rpcUrl),
    });

    const registry = DEXRegistry.getInstance();

    // Same allow/block filtering the Stacks path applies — a token a user has
    // blocked shouldn't reappear in their portfolio just because it's on Base.
    let userBlockedSet = new Set<string>();
    if (userId) {
      try {
        const db = DatabaseService.getInstance();
        const userBlocked = await db.getBlockedTokens(userId);
        userBlockedSet = new Set(userBlocked.map((b) => b.contractId));
      } catch {
        // Blocked token lookup failed, proceed without per-user blocking
      }
    }
    const allowedTokens = ConfigManager.getInstance().allowedTokens;
    const blockedTokens = ConfigManager.getInstance().blockedTokens;

    let ethBalance = 0;
    let ethPrice = 0;
    try {
      const rawBalance = await client.getBalance({ address: address as `0x${string}` });
      // formatUnits, not Number(raw)/1e18 — a wei value above 2^53 loses
      // precision as a double before the division.
      ethBalance = Number(formatUnits(rawBalance, 18));
      // Scoped to "evm": unscoped, a Stacks provider listing a "WETH" symbol
      // would answer first and price Base ETH off the wrong chain.
      ethPrice = await registry.getTokenPrice("WETH", "evm");
    } catch (err) {
      logger.warn("Failed to fetch ETH balance", { address, error: err instanceof Error ? err.message : String(err) });
    }

    const balances: TokenBalance[] = [];
    if (ethBalance > 0) {
      // usdValue is 0 when no on-chain price was available. Left uninvented
      // rather than defaulted to a guessed ETH price, because this figure
      // feeds RiskManager position sizing.
      const usdValue = ethBalance * ethPrice;
      if (ignoreDust || usdValue >= this.dustThresholdUsd) {
        balances.push({
          token: "ETH",
          symbol: "ETH",
          balance: ethBalance,
          usdValue,
        });
      }
    }

    const evmTokens = swappableTokens.filter(
      (t) => (t.chainFamily ?? (t.contractId.startsWith("0x") ? "evm" : "stacks")) === "evm"
    );

    const tokenBalances = await Promise.all(
      evmTokens.map(async (token) => {
        if (allowedTokens.length > 0 && !allowedTokens.includes(token.contractId)) return null;
        if (blockedTokens.length > 0 && blockedTokens.includes(token.contractId)) return null;
        if (userBlockedSet.has(token.contractId)) return null;

        try {
          const rawBalance = await client.readContract({
            address: token.contractId as `0x${string}`,
            abi: ERC20_ABI,
            functionName: "balanceOf",
            args: [address as `0x${string}`],
          }) as bigint;

          const balance = Number(formatUnits(rawBalance, token.decimals));
          if (balance <= 0) return null;

          const tokenPrice = await registry.getTokenPrice(token.symbol, "evm");
          const usdValue = balance * (tokenPrice || 1.0);

          if (!ignoreDust && usdValue < this.dustThresholdUsd) return null;

          return {
            token: token.contractId,
            symbol: token.symbol,
            balance,
            usdValue,
          };
        } catch (err) {
          logger.warn(`Failed to fetch ERC20 balance for ${token.symbol}`, {
            address,
            token: token.contractId,
            error: err instanceof Error ? err.message : String(err),
          });
          return null;
        }
      })
    );

    for (const tb of tokenBalances) {
      if (tb) balances.push(tb);
    }

    return balances;
  }

  async fetchBalances(
    address: string,
    swappableTokens: SwappableToken[],
    userId?: number,
    ignoreDust: boolean = false,
    chainId?: string
  ): Promise<TokenBalance[]> {
    // Prefer the caller's chainId. Address-shape sniffing was workable with two
    // families but does not survive three: a Solana address is base58 like a
    // Stacks principal, so shape alone can no longer tell them apart. The
    // sniffing fallback stays for callers that haven't been threaded through.
    const family = chainId
      ? familyOfChainId(chainId) ?? (chainId.startsWith("stacks") ? "stacks" : "evm")
      : address.startsWith("0x") && address.length === 42
        ? "evm"
        : SOLANA_ADDRESS_RE.test(address) && !address.startsWith("S")
          ? "svm"
          : "stacks";

    if (family === "evm") {
      return this.fetchEvmBalances(address, swappableTokens, ignoreDust, userId);
    }

    if (family === "svm") {
      return this.fetchSvmBalances(address, swappableTokens, ignoreDust, userId, chainId);
    }

    const balances: TokenBalance[] = [];
    const config = ConfigManager.getInstance().config;

    let userBlockedSet = new Set<string>();
    if (userId) {
      try {
        const db = DatabaseService.getInstance();
        const userBlocked = await db.getBlockedTokens(userId);
        userBlockedSet = new Set(userBlocked.map((b) => b.contractId));
      } catch {
        // Blocked token lookup failed, proceed without per-user blocking
      }
    }

    const urls = [
      config.STACKS_API_URL,
      ...config.STACKS_FALLBACK_API_URLS
        .split(",")
        .map((u) => u.trim())
        .filter(Boolean),
    ];

    let data: StacksBalance | null = null;
    let fetchError: any = null;

    for (const url of urls) {
      try {
        const headers: Record<string, string> = {};
        if (config.HIRO_API_KEY && url.includes("hiro.so")) {
          headers["x-api-key"] = config.HIRO_API_KEY;
        }

        const response = await axios.get<StacksBalance>(
          `${url}/extended/v1/address/${address}/balances`,
          { headers, timeout: 5000 }
        );
        data = response.data;
        break;
      } catch (err) {
        fetchError = err;
        logger.warn("Failed to fetch balances from URL, trying fallback", {
          url,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (!data) {
      logger.error("All RPC nodes failed for balance fetch", { address, error: fetchError });
      throw fetchError || new Error("All RPC nodes failed for balance fetch");
    }

    try {
      const registry = DEXRegistry.getInstance();
      const stxPrice = await registry.getTokenPrice("STX");

      const stxBalance =
        parseInt(data.stx.balance, 10) / 1_000_000;
      balances.push({
        token: "STX",
        symbol: "STX",
        balance: stxBalance,
        usdValue: stxBalance * (stxPrice || 2.0),
      });

      const tokenMap = new Map(
        swappableTokens.map((t) => [t.contractId, t])
      );

      const allowedTokens = ConfigManager.getInstance().allowedTokens;
      const blockedTokens = ConfigManager.getInstance().blockedTokens;

      for (const [contractId, tokenData] of Object.entries(
        data.fungible_tokens ?? {}
      )) {
        const baseContractId = contractId.split("::")[0] || contractId;
        const token = tokenMap.get(baseContractId) || tokenMap.get(contractId);
        if (!token) continue;

        const checkId = token.contractId;
        if (allowedTokens.length > 0 && !allowedTokens.includes(checkId)) {
          continue;
        }
        if (blockedTokens.length > 0 && blockedTokens.includes(checkId)) {
          continue;
        }
        if (userBlockedSet.has(checkId)) {
          continue;
        }

        const rawBalance = parseInt(tokenData.balance, 10);
        const balance = rawBalance / 10 ** token.decimals;

        if (balance <= 0) continue;

        const tokenPrice = await registry.getTokenPrice(token.symbol);
        const usdValue = balance * (tokenPrice || 1.0);

        if (!ignoreDust && usdValue < this.dustThresholdUsd) continue;

        balances.push({
          token: token.contractId,
          symbol: token.symbol,
          balance,
          usdValue,
        });
      }
    } catch (error) {
      logger.error("Failed to process fetched balances", { address, error });
      throw error;
    }

    return balances;
  }

  computeRebalanceActions(
    currentBalances: TokenBalance[],
    targets: PortfolioTarget[],
    rebalanceThreshold: number
  ): RebalanceAction[] {
    const actions = runRebalance(currentBalances, targets, rebalanceThreshold);

    const totalValue = currentBalances.reduce((sum, b) => sum + b.usdValue, 0);
    logger.info("Rebalance actions computed", {
      totalValue: totalValue.toFixed(2),
      actionCount: actions.length,
    });

    return actions;
  }
}

export function runRebalance(
  currentBalances: TokenBalance[],
  targets: PortfolioTarget[],
  rebalanceThreshold: number
): RebalanceAction[] {
  const actions: RebalanceAction[] = [];
  const totalValue = currentBalances.reduce((sum, b) => sum + b.usdValue, 0);

  if (totalValue <= 0) return actions;

  const currentWeights = new Map<string, number>();
  for (const b of currentBalances) {
    currentWeights.set(b.symbol, b.usdValue / totalValue);
  }

  for (const target of targets) {
    const currentWeight = currentWeights.get(target.token) ?? 0;
    const deviation = target.targetWeight - currentWeight;
    const absDeviation = Math.abs(deviation);

    if (absDeviation < rebalanceThreshold / 100) continue;

    if (deviation > 0) {
      const targetValue = target.targetWeight * totalValue;
      const currentValue = currentWeight * totalValue;
      const buyAmount = targetValue - currentValue;

      const stxBalance = currentBalances.find((b) => b.symbol === "STX");
      const stxValue = stxBalance?.usdValue ?? 0;

      if (stxValue < buyAmount) continue;

      const stxPrice =
        stxBalance && stxBalance.balance > 0
          ? stxBalance.usdValue / stxBalance.balance
          : 2.0;
      const stxToSpend = buyAmount / stxPrice;

      actions.push({
        tokenIn: "STX",
        tokenOut: target.token,
        amountIn: stxToSpend,
        direction: "BUY",
        reason: `Underweight ${target.token} by ${(absDeviation * 100).toFixed(1)}%`,
      });
    } else {
      const currentValue = currentWeight * totalValue;
      const targetValue = target.targetWeight * totalValue;
      const sellAmount = currentValue - targetValue;

      if (target.token === "STX") continue;

      const tokenBalance = currentBalances.find(
        (b) => b.symbol === target.token
      );
      if (!tokenBalance || tokenBalance.balance <= 0) continue;

      const sellUnits =
        sellAmount / (tokenBalance.usdValue / tokenBalance.balance);

      actions.push({
        tokenIn: target.token,
        tokenOut: "STX",
        amountIn: Math.min(sellUnits, tokenBalance.balance),
        direction: "SELL",
        reason: `Overweight ${target.token} by ${(absDeviation * 100).toFixed(1)}%`,
      });
    }
  }

  actions.sort((a, b) => Math.abs(b.amountIn) - Math.abs(a.amountIn));

  return actions;
}
