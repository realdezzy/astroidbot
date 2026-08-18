/**
 * Reads the fields an indexer needs out of a Clarity `print` payload.
 *
 * Stacks AMMs announce every swap with a `print` whose value is a Clarity
 * tuple. The API returns it two ways: `hex` (the serialized value) and `repr`
 * (Clarity's own source-like rendering). This parses `repr`.
 *
 * Parsing a rendered form is normally the wrong instinct, so: deserializing the
 * hex would mean depending on the wire format and then walking a ClarityValue
 * tree whose *shape differs per protocol anyway*. Everything extracted here is
 * a scalar — a `uint` or a contract principal — and `repr` renders those
 * identically for every contract that emits them.
 *
 * The dialects are genuinely different, which is why this dispatches on dexId
 * rather than trying to find one set of field names:
 *
 *   ALEX   (action "swap-x-for-y") (dx u…) (dy u…) (token-x '…) (token-y '…)
 *   Velar  (op "swap") (amt-in u…) (amt-out u…) (token-in '…) (token-out '…)
 *
 * That knowledge is protocol behaviour, so it lives in code. The descriptor
 * only says *which contracts* to watch — a list a deployment might reasonably
 * change — not how to read them.
 */

export interface DecodedStacksSwap {
  /** Stable pool identity within the contract. */
  poolKey: string;
  /** Canonical pair ordering, as the protocol itself orders it. */
  token0: string;
  token1: string;
  /** Raw amounts moved, in each token's own base units. Always positive. */
  amount0: bigint;
  amount1: bigint;
  /** True when token0 flowed *into* the pool — i.e. token0 was sold. */
  zeroForOne: boolean;
  /** Post-swap reserves, when the print reports them. */
  reserve0: bigint | null;
  reserve1: bigint | null;
}

function stringField(repr: string, name: string): string | null {
  return repr.match(new RegExp(`\\(${name} "([^"]*)"\\)`))?.[1] ?? null;
}

/**
 * Returned as bigint because these are raw base units — a token with 18
 * decimals overflows a double long before it overflows anything on-chain.
 */
function uintField(repr: string, name: string): bigint | null {
  const match = repr.match(new RegExp(`\\(${name} u(\\d+)\\)`));
  return match ? BigInt(match[1]!) : null;
}

/**
 * The trailing `)` is excluded from the character class rather than the match
 * being made lazy: a principal contains dots and hyphens, and a lazy match
 * would stop at the first of them.
 */
function principalField(repr: string, name: string): string | null {
  return repr.match(new RegExp(`\\(${name} '([^)\\s]+)\\)`))?.[1] ?? null;
}

/**
 * ALEX: `amm-pool-v2-01`.
 *
 * Direction comes from the action name, and x/y are already the canonical
 * ordering — `dx` is always the token-x amount whichever way the swap went.
 */
function decodeAlex(repr: string): DecodedStacksSwap | null {
  const action = stringField(repr, "action");
  if (action !== "swap-x-for-y" && action !== "swap-y-for-x") return null;

  const token0 = principalField(repr, "token-x");
  const token1 = principalField(repr, "token-y");
  const amount0 = uintField(repr, "dx");
  const amount1 = uintField(repr, "dy");
  if (!token0 || !token1 || amount0 === null || amount1 === null) return null;

  return {
    poolKey: uintField(repr, "pool-id")?.toString() ?? `${token0}/${token1}`,
    token0,
    token1,
    amount0,
    amount1,
    zeroForOne: action === "swap-x-for-y",
    reserve0: uintField(repr, "balance-x"),
    reserve1: uintField(repr, "balance-y"),
  };
}

/**
 * Velar: `univ2-core`.
 *
 * `amt-in`/`amt-out` are relative to the swap, not to the pair, so they are
 * assigned to token0/token1 by comparing `token-in` against the pool's
 * `token0`. Reading them positionally would silently invert every sell.
 *
 * Reserves come from `b0`/`b1` rather than the nested `reserve0`/`reserve1`:
 * those are the *pre*-swap values, and a pool's liquidity should reflect the
 * trade that just happened.
 */
function decodeVelar(repr: string): DecodedStacksSwap | null {
  if (stringField(repr, "op") !== "swap") return null;

  const token0 = principalField(repr, "token0");
  const token1 = principalField(repr, "token1");
  const tokenIn = principalField(repr, "token-in");
  const amountIn = uintField(repr, "amt-in");
  const amountOut = uintField(repr, "amt-out");

  if (!token0 || !token1 || !tokenIn || amountIn === null || amountOut === null) return null;

  const zeroForOne = tokenIn === token0;

  return {
    poolKey: uintField(repr, "id")?.toString() ?? `${token0}/${token1}`,
    token0,
    token1,
    amount0: zeroForOne ? amountIn : amountOut,
    amount1: zeroForOne ? amountOut : amountIn,
    zeroForOne,
    reserve0: uintField(repr, "b0"),
    reserve1: uintField(repr, "b1"),
  };
}

function decodeBitflow(repr: string): DecodedStacksSwap | null {
  const action = stringField(repr, "action") ?? stringField(repr, "op");
  if (action !== "swap" && action !== "swap-x-for-y" && action !== "swap-y-for-x" && action !== "swap-tokens") return null;

  const token0 = principalField(repr, "token-x") ?? principalField(repr, "token0") ?? principalField(repr, "token-in");
  const token1 = principalField(repr, "token-y") ?? principalField(repr, "token1") ?? principalField(repr, "token-out");
  const amount0 = uintField(repr, "dx") ?? uintField(repr, "amt-in") ?? uintField(repr, "amount-in");
  const amount1 = uintField(repr, "dy") ?? uintField(repr, "amt-out") ?? uintField(repr, "amount-out");

  if (!token0 || !token1 || amount0 === null || amount1 === null) return null;

  const zeroForOne = action === "swap-x-for-y" || principalField(repr, "token-in") === token0;

  return {
    poolKey: uintField(repr, "pool-id")?.toString() ?? `${token0}/${token1}`,
    token0,
    token1,
    amount0,
    amount1,
    zeroForOne,
    reserve0: uintField(repr, "reserve-x") ?? uintField(repr, "b0"),
    reserve1: uintField(repr, "reserve-y") ?? uintField(repr, "b1"),
  };
}

const DIALECTS: Record<string, (repr: string) => DecodedStacksSwap | null> = {
  alex: decodeAlex,
  velar: decodeVelar,
  bitflow: decodeBitflow,
};

/** True when a dialect exists for this DEX. */
export function canDecodeStacksDex(dexId: string): boolean {
  return dexId in DIALECTS;
}

/**
 * Decodes a swap print, or returns null when the print isn't one.
 *
 * Null is the common case and not an error: these contracts also print for
 * liquidity events, governance and fee collection, and a tick that warned on
 * each would bury everything else.
 */
export function decodeStacksSwapPrint(repr: string, dexId: string): DecodedStacksSwap | null {
  if (!repr) return null;

  const decoded = DIALECTS[dexId]?.(repr);
  if (!decoded) return null;

  // A zero-amount swap is a no-op the contract still announces. Recording one
  // would add to the transaction count and put a price of zero in the candle.
  if (decoded.amount0 === 0n || decoded.amount1 === 0n) return null;

  return decoded;
}
