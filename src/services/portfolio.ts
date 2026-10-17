import axios from "axios";
import { ConfigManager } from "../config.js";
import { logger } from "../utils/logger.js";
import { DEXRegistry } from "./dex/dexRegistry.js";
import { DatabaseService } from "./db.js";
import { formatUnits, type PublicClient } from "viem";
import { ERC20_ABI } from "./chains/evm/abis.js";
import { publicClientFor } from "./chains/evm/evmClient.js";
import { hasMulticall3, multicallRead } from "./chains/evm/multicall.js";
import { familyOfChainId } from "../types/chain.js";
import { ChainAdapterRegistry } from "./chains/chainAdapterRegistry.js";
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
   * A balance valued at `price`, or flagged `unpriced` with a usdValue of 0.
   *
   * Every chain's path values through here so they cannot drift apart again:
   * the EVM and Stacks token paths substituted $1 per unit for a missing
   * price, while the native and Solana paths used 0, and the $1 fed
   * RiskManager position sizing as though it had been observed.
   */
  private valued(
    entry: { token: string; symbol: string; balance: number },
    price: number | null | undefined
  ): TokenBalance {
    if (price === null || price === undefined || !(price > 0)) {
      return { ...entry, usdValue: 0, unpriced: true };
    }
    return { ...entry, usdValue: entry.balance * price };
  }

  /**
   * Dust is a balance known to be worth almost nothing. An unpriced balance
   * is not known to be worth anything in particular, so it is never dust —
   * filtering it would hide a real holding of unknown value.
   */
  private isDust(balance: TokenBalance, ignoreDust: boolean): boolean {
    return !ignoreDust && !balance.unpriced && balance.usdValue < this.dustThresholdUsd;
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
    userId: number | undefined,
    chainId: string
  ): Promise<TokenBalance[]> {
    const registry = DEXRegistry.getInstance();
    const scope = chainId;
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
        const solPrice = await registry.getTokenPrice("SOL", scope).catch(() => null);
        const sol = this.valued({ token: "SOL", symbol: "SOL", balance: solBalance }, solPrice);
        if (!this.isDust(sol, ignoreDust)) balances.push(sol);
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
        const price = await registry.getTokenPrice(symbol, scope).catch(() => null);
        const spl = this.valued({ token: mint, symbol, balance: amount }, price);
        if (!this.isDust(spl, ignoreDust)) balances.push(spl);
      }
    } catch (err) {
      logger.warn("Failed to fetch Solana balances", {
        address,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return balances;
  }

  /**
   * ERC-20 and native balances for one wallet, on that wallet's own chain.
   *
   * The chain used to be hardcoded to Base: `fetchBalances` resolved the
   * wallet's ChainId, threaded it to the Solana path, and dropped it here,
   * building its client from BASE_NETWORK/BASE_RPC_URL. A Celo, Ethereum or
   * Robinhood wallet therefore had its balances read off Base — which returns
   * successfully, with zeros, so it looked like an empty wallet rather than a
   * misrouted query.
   */
  private async fetchEvmBalances(
    address: string,
    swappableTokens: SwappableToken[],
    ignoreDust: boolean,
    userId: number | undefined,
    chainId: string
  ): Promise<TokenBalance[]> {
    const registryOfChains = ChainAdapterRegistry.getInstance();
    const resolvedChainId = chainId;

    if (!registryOfChains.has(resolvedChainId)) {
      logger.warn("Cannot read EVM balances for a chain that is not enabled", {
        address,
        chainId: resolvedChainId,
      });
      return [];
    }

    const descriptor = registryOfChains.get(resolvedChainId).descriptor;
    const client = publicClientFor(descriptor);

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

    let nativeBalance = 0;
    let nativePrice: number | null = null;
    try {
      const rawBalance = await client.getBalance({ address: address as `0x${string}` });
      // formatUnits, not Number(raw)/1e18 — a wei value above 2^53 loses
      // precision as a double before the division.
      nativeBalance = Number(formatUnits(rawBalance, descriptor.nativeDecimals));
      // Scoped to this ChainId, not the bare "evm" family. A family scope
      // matches every EVM DEX on every EVM chain, so a Celo wallet's CELO
      // could be priced by a Base router that has never heard of it.
      nativePrice = await registry.getTokenPrice(descriptor.nativeSymbol, resolvedChainId);
    } catch (err) {
      logger.warn("Failed to fetch native balance", {
        address,
        chainId: resolvedChainId,
        symbol: descriptor.nativeSymbol,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    const balances: TokenBalance[] = [];
    if (nativeBalance > 0) {
      const native = this.valued(
        { token: descriptor.nativeSymbol, symbol: descriptor.nativeSymbol, balance: nativeBalance },
        nativePrice
      );
      if (!this.isDust(native, ignoreDust)) balances.push(native);
    }

    // Scoped to this chain, not to the EVM family. Filtering by family alone
    // put Base's USDC in a Celo wallet's balance list, where the read returns
    // zero and the row silently vanishes — or worse, returns a real balance
    // for a same-address token on the other chain.
    const chainTokens = swappableTokens.filter((token) => {
      if (token.chainId) return token.chainId === resolvedChainId;
      // Older callers pass no chainId. Fall back to the family test, which is
      // what this did for every token before.
      const family = token.chainFamily ?? (token.contractId.startsWith("0x") ? "evm" : "stacks");
      return family === "evm";
    });

    // A chain whose native asset is also an ERC-20 would otherwise report the
    // same holding twice: once from eth_getBalance above, once from the
    // balanceOf below. Arc is that chain — its gas token is USDC and
    // 0x3600…0000 is the same balance at 6 decimals rather than 18, not a
    // second position. Doubling it would not just look wrong: portfolio value
    // is what RiskManager sizes positions against, so every cap on the chain
    // would be twice what the user set. The native row wins because it is the
    // authoritative one for gas.
    const nativeAlias = descriptor.evm?.nativeErc20?.address.toLowerCase();

    const wanted = chainTokens.filter((token) => {
      if (nativeAlias && token.contractId.toLowerCase() === nativeAlias) return false;
      if (allowedTokens.length > 0 && !allowedTokens.includes(token.contractId)) return false;
      if (blockedTokens.length > 0 && blockedTokens.includes(token.contractId)) return false;
      return !userBlockedSet.has(token.contractId);
    });

    // One batched call rather than one `eth_call` per listed token. This runs
    // on a user-facing request, and the token list grows with every chain the
    // deployment enables.
    const raw = await batchBalanceOf(
      client,
      resolvedChainId,
      address,
      wanted.map((t) => t.contractId)
    );

    const held = wanted.flatMap((token, index) => {
      const rawBalance = raw[index];
      if (typeof rawBalance !== "bigint") return [];

      const balance = Number(formatUnits(rawBalance, token.decimals));
      return balance > 0 ? [{ token, balance }] : [];
    });

    // Priced only for tokens actually held, and scoped to this chain.
    const priced = await Promise.all(
      held.map(async ({ token, balance }) => {
        const tokenPrice = await registry
          .getTokenPrice(token.symbol, resolvedChainId)
          .catch(() => null);
        return this.valued({ token: token.contractId, symbol: token.symbol, balance }, tokenPrice);
      })
    );

    for (const entry of priced) {
      if (!this.isDust(entry, ignoreDust)) balances.push(entry);
    }

    return balances;
  }

  async fetchBalances(
    address: string,
    swappableTokens: SwappableToken[],
    userId: number | undefined,
    ignoreDust: boolean,
    chainId: string
  ): Promise<TokenBalance[]> {
    // The chain is required, not sniffed from the address. Address shape cannot
    // tell a Solana address from a Stacks principal, nor one EVM chain from
    // another: an omitted chainId used to fall back to Base, so a Robinhood or
    // Celo wallet had its balances read off Base and showed believable zeros.
    const family = familyOfChainId(chainId) ?? (chainId.startsWith("stacks") ? "stacks" : "evm");

    if (family === "evm") {
      // chainId is passed through rather than dropped. It was resolved above
      // and handed to the SVM path; the EVM path ignored it and read Base.
      return this.fetchEvmBalances(address, swappableTokens, ignoreDust, userId, chainId);
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
    let fetchError: unknown = null;

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
      // Scoped: this is the Stacks path, and an unscoped lookup could answer
      // with any chain's same-ticker token.
      const scope = chainId;
      const stxPrice = await registry.getTokenPrice("STX", scope).catch(() => null);

      const stxBalance =
        parseInt(data.stx.balance, 10) / 1_000_000;
      // Pushed regardless of dust, as before. This substituted a flat $2.00
      // for an unavailable STX price, which then fed RiskManager position
      // sizing as though measured.
      balances.push(this.valued({ token: "STX", symbol: "STX", balance: stxBalance }, stxPrice));

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

        // Caught per token: one unpriceable token used to throw out of the
        // loop and fail the whole wallet's balance read.
        const tokenPrice = await registry.getTokenPrice(token.symbol, scope).catch(() => null);
        const ft = this.valued({ token: token.contractId, symbol: token.symbol, balance }, tokenPrice);
        if (!this.isDust(ft, ignoreDust)) balances.push(ft);
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
    rebalanceThreshold: number,
    nativeSymbol: string
  ): RebalanceAction[] {
    const actions = runRebalance(currentBalances, targets, rebalanceThreshold, nativeSymbol);

    const totalValue = currentBalances.reduce((sum, b) => sum + b.usdValue, 0);
    logger.info("Rebalance actions computed", {
      totalValue: totalValue.toFixed(2),
      actionCount: actions.length,
    });

    return actions;
  }
}

/**
 * Trades that move a portfolio toward target weights, funded from and settled
 * into `nativeSymbol` — the wallet chain's native asset. That was "STX" here,
 * so a rebalance on any other chain looked for a balance it could not hold.
 *
 * Unpriced balances take no part. Their weight cannot be measured: one always
 * reads as 0%, so a target above that would buy it again on every cycle
 * without the position ever appearing to grow.
 */
export function runRebalance(
  allBalances: TokenBalance[],
  targets: PortfolioTarget[],
  rebalanceThreshold: number,
  nativeSymbol: string
): RebalanceAction[] {
  const actions: RebalanceAction[] = [];
  const currentBalances = allBalances.filter((b) => !b.unpriced);
  const unpricedSymbols = new Set(allBalances.filter((b) => b.unpriced).map((b) => b.symbol));
  const totalValue = currentBalances.reduce((sum, b) => sum + b.usdValue, 0);

  if (totalValue <= 0) return actions;

  const currentWeights = new Map<string, number>();
  for (const b of currentBalances) {
    currentWeights.set(b.symbol, b.usdValue / totalValue);
  }

  for (const target of targets) {
    if (unpricedSymbols.has(target.token)) continue;
    const currentWeight = currentWeights.get(target.token) ?? 0;
    const deviation = target.targetWeight - currentWeight;
    const absDeviation = Math.abs(deviation);

    if (absDeviation < rebalanceThreshold / 100) continue;

    if (deviation > 0) {
      const targetValue = target.targetWeight * totalValue;
      const currentValue = currentWeight * totalValue;
      const buyAmount = targetValue - currentValue;

      const nativeBalance = currentBalances.find((b) => b.symbol === nativeSymbol);
      const nativeValue = nativeBalance?.usdValue ?? 0;

      if (nativeValue < buyAmount) continue;

      // Derived from the balance we are holding, which is a real observation.
      // The fallback here was a flat 2.0, and this price is the divisor that
      // decides how much of the native asset to spend — so a wrong one does
      // not fail, it silently sizes the trade wrong.
      if (!nativeBalance || nativeBalance.balance <= 0) continue;
      const nativePrice = nativeBalance.usdValue / nativeBalance.balance;
      if (!Number.isFinite(nativePrice) || nativePrice <= 0) continue;
      const nativeToSpend = buyAmount / nativePrice;

      actions.push({
        tokenIn: nativeSymbol,
        tokenOut: target.token,
        amountIn: nativeToSpend,
        direction: "BUY",
        reason: `Underweight ${target.token} by ${(absDeviation * 100).toFixed(1)}%`,
      });
    } else {
      const currentValue = currentWeight * totalValue;
      const targetValue = target.targetWeight * totalValue;
      const sellAmount = currentValue - targetValue;

      if (target.token === nativeSymbol) continue;

      const tokenBalance = currentBalances.find(
        (b) => b.symbol === target.token
      );
      if (!tokenBalance || tokenBalance.balance <= 0) continue;

      const sellUnits =
        sellAmount / (tokenBalance.usdValue / tokenBalance.balance);

      actions.push({
        tokenIn: target.token,
        tokenOut: nativeSymbol,
        amountIn: Math.min(sellUnits, tokenBalance.balance),
        direction: "SELL",
        reason: `Overweight ${target.token} by ${(absDeviation * 100).toFixed(1)}%`,
      });
    }
  }

  actions.sort((a, b) => Math.abs(b.amountIn) - Math.abs(a.amountIn));

  return actions;
}

/**
 * `balanceOf` for one holder across many tokens, in as few calls as possible.
 *
 * Multicall3 where the chain has it — every chain checked so far does — and
 * individual reads otherwise, so a chain without it degrades in speed rather
 * than in correctness. An unreadable token is `null`, which the caller skips:
 * a token that reverts on `balanceOf` is not one the wallet holds.
 */
async function batchBalanceOf(
  client: PublicClient,
  chainId: string,
  holder: string,
  tokens: string[]
): Promise<(unknown | null)[]> {
  if (tokens.length === 0) return [];

  const requests = tokens.map((contractId) => ({
    address: contractId,
    abi: ERC20_ABI,
    functionName: "balanceOf",
    args: [holder as `0x${string}`],
  }));

  if (await hasMulticall3(client, chainId)) {
    return multicallRead(client, requests);
  }

  return Promise.all(
    tokens.map(async (contractId) => {
      try {
        return await client.readContract({
          address: contractId as `0x${string}`,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [holder as `0x${string}`],
        });
      } catch {
        return null;
      }
    })
  );
}
