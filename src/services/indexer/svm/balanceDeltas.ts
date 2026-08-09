/**
 * Derives a swap's amounts from a Solana transaction's token-balance deltas.
 *
 * The alternative is a decoder per AMM program — Raydium AMM v4, Raydium CLMM,
 * Orca Whirlpools, Meteora DLMM, Lifinity, Phoenix, and whatever launched this
 * month — each with its own instruction layout, and each a new way for
 * ingestion to silently stop working when a program is upgraded.
 *
 * The runtime already reports what we need. Every transaction's meta carries
 * `preTokenBalances` and `postTokenBalances`: for each token account it
 * touched, the mint, the owner, and the balance before and after. A swap moves
 * one mint *into* the pool and another *out*, so diffing the pool's own
 * accounts gives exact in/out amounts — for any program, including ones that
 * don't exist yet.
 *
 * What this cannot see is *which* program did it. That is fine: the pool
 * address already identifies the venue, and a candle records what traded, not
 * by what code.
 */

export interface SolanaTokenBalance {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount: { amount: string; decimals: number };
}

export interface SolanaTransactionMeta {
  err?: unknown;
  preTokenBalances?: SolanaTokenBalance[];
  postTokenBalances?: SolanaTokenBalance[];
}

export interface DecodedSolanaSwap {
  /** Raw amounts in each mint's base units, always positive. */
  amount0: bigint;
  amount1: bigint;
  /** True when token0 flowed *into* the pool — token0 was sold. */
  zeroForOne: boolean;
}

/**
 * Net movement per mint across the accounts *the pool owns*.
 *
 * The scoping is the whole trick, and getting it wrong is silent. Summing over
 * every account in the transaction yields exactly zero for every mint, because
 * a swap conserves tokens: whatever the trader loses, the pool gains. The
 * first version of this did precisely that and decoded nothing, while its unit
 * tests — written against a trader's-eye view — passed.
 *
 * A pool's vaults are token accounts owned by the pool account itself, so
 * filtering on `owner` isolates the pool's side of the trade. It also handles
 * the case that matters most for correctness: in a multi-hop route, the other
 * pools' vaults are filtered out, so this pool is credited with its own leg
 * rather than the whole route.
 */
function netByMint(meta: SolanaTransactionMeta, poolAddress: string): Map<string, bigint> {
  const before = new Map<number, { mint: string; amount: bigint; owner?: string }>();

  for (const balance of meta.preTokenBalances ?? []) {
    before.set(balance.accountIndex, {
      mint: balance.mint,
      amount: BigInt(balance.uiTokenAmount.amount || "0"),
      owner: balance.owner,
    });
  }

  const net = new Map<string, bigint>();

  for (const balance of meta.postTokenBalances ?? []) {
    const prior = before.get(balance.accountIndex);
    before.delete(balance.accountIndex);

    // `owner` can be absent on either side of the pair; the pre entry is the
    // fallback because an account created during the transaction has no pre.
    const owner = balance.owner ?? prior?.owner;
    if (owner !== poolAddress) continue;

    const delta = BigInt(balance.uiTokenAmount.amount || "0") - (prior?.amount ?? 0n);
    if (delta === 0n) continue;

    net.set(balance.mint, (net.get(balance.mint) ?? 0n) + delta);
  }

  // Accounts present before and absent after were closed — their whole balance
  // left. Rare for a pool vault, but a pool being drained and closed is exactly
  // the event worth not misreading as "no movement".
  for (const { mint, amount, owner } of before.values()) {
    if (owner !== poolAddress || amount === 0n) continue;
    net.set(mint, (net.get(mint) ?? 0n) - amount);
  }

  return net;
}

/**
 * The swap between `token0` and `token1`, or null when this transaction
 * doesn't contain one.
 *
 * Null is the common case: a pool account appears in liquidity deposits,
 * withdrawals, fee harvests and unrelated routes that merely read it.
 *
 * It is also what an AMM whose vaults are owned by a shared program authority
 * rather than by the pool returns. Those are not decodable this way, which is
 * why `probeDecodable` exists — a pool that can never be read is dropped at
 * discovery rather than tracked forever while yielding nothing.
 */
export function decodeSolanaSwap(
  meta: SolanaTransactionMeta,
  poolAddress: string,
  token0: string,
  token1: string
): DecodedSolanaSwap | null {
  if (meta.err) return null;

  const net = netByMint(meta, poolAddress);
  const delta0 = net.get(token0);
  const delta1 = net.get(token1);

  // Both sides must have moved. One side alone is a deposit or a withdrawal,
  // and recording it as a swap would invent a price from a trade that set none.
  if (delta0 === undefined || delta1 === undefined) return null;
  if (delta0 === 0n || delta1 === 0n) return null;

  // Opposite signs are what makes it a swap. Same-sign movement on both mints
  // is a two-sided liquidity change.
  if (delta0 > 0n === delta1 > 0n) return null;

  const abs = (value: bigint): bigint => (value < 0n ? -value : value);

  return {
    amount0: abs(delta0),
    amount1: abs(delta1),
    // Signs are from the *pool's* perspective, since that is whose accounts
    // these are: token0 rising means the pool received it, i.e. it was sold.
    zeroForOne: delta0 > 0n,
  };
}

/**
 * Whether this pool's swaps can be read at all.
 *
 * Used at discovery time. Some AMMs hold their vaults under a shared program
 * authority rather than under the pool account, and those decode to nothing
 * here — silently, and forever, which is the failure mode this codebase keeps
 * being bitten by. Checking once against recent history turns "this venue is
 * invisible" into "this venue was not tracked", which is a fact somebody can
 * see.
 */
export function probeDecodable(
  metas: SolanaTransactionMeta[],
  poolAddress: string,
  token0: string,
  token1: string
): boolean {
  return metas.some((meta) => decodeSolanaSwap(meta, poolAddress, token0, token1) !== null);
}
