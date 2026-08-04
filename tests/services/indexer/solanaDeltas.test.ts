import { describe, it, expect } from "vitest";
import {
  decodeSolanaSwap,
  probeDecodable,
  type SolanaTransactionMeta,
} from "../../../src/services/indexer/svm/balanceDeltas.js";

/**
 * Deriving Solana swap amounts from token-balance deltas.
 *
 * The alternative was a decoder per AMM program — Raydium v4, Raydium CLMM,
 * Orca Whirlpools, Meteora, Lifinity, and whatever ships next — each a new way
 * for ingestion to break silently on a program upgrade. The runtime already
 * reports every touched token account's balance before and after, so diffing
 * the pool's mints works for any program, including ones that don't exist yet.
 *
 * **These fixtures are shaped like the pool, not like the trader.** The first
 * version of this file wasn't, and every test passed while the decoder read
 * exactly nothing from mainnet: summed across all of a transaction's accounts,
 * every mint nets to zero, because a swap conserves tokens. Whatever the
 * trader loses, the pool gains. The `owner` field is what separates them, so
 * every balance here carries one.
 */

const SOL = "So11111111111111111111111111111111111111112";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const POOL = "6Vzx4ASRjUPW2yBxHdBT3hDam2zxB6UmhM2MYYM5k8ci";
const TRADER = "6o3KnTswAr9M6H4pJvNbXvHqXPPvT9nBEuTPXQpRAAAA";

/** Defaults to a pool-owned vault, since that is what the decoder reads. */
function balance(
  accountIndex: number,
  mint: string,
  amount: string,
  decimals = 9,
  owner: string = POOL
) {
  return { accountIndex, mint, owner, uiTokenAmount: { amount, decimals } };
}

function meta(
  pre: ReturnType<typeof balance>[],
  post: ReturnType<typeof balance>[],
  err: unknown = undefined
): SolanaTransactionMeta {
  return { err, preTokenBalances: pre, postTokenBalances: post };
}

describe("Solana balance-delta decoding", () => {
  it("reads a swap as opposite movements in the pool's vaults", () => {
    // The pool receives SOL and pays out USDC — a trader selling SOL.
    const decoded = decodeSolanaSwap(
      meta(
        [balance(1, SOL, "4000000000"), balance(2, USDC, "75000000", 6)],
        [balance(1, SOL, "5000000000"), balance(2, USDC, "1000000", 6)]
      ),
      POOL,
      SOL,
      USDC
    )!;

    expect(decoded.amount0).toBe(1_000_000_000n);
    expect(decoded.amount1).toBe(74_000_000n);
    // The vault's token0 rose, so token0 went *into* the pool.
    expect(decoded.zeroForOne).toBe(true);
  });

  it("reads the reverse direction", () => {
    const decoded = decodeSolanaSwap(
      meta(
        [balance(1, SOL, "5000000000"), balance(2, USDC, "1000000", 6)],
        [balance(1, SOL, "4000000000"), balance(2, USDC, "75000000", 6)]
      ),
      POOL,
      SOL,
      USDC
    )!;

    expect(decoded.zeroForOne).toBe(false);
    expect(decoded.amount0).toBe(1_000_000_000n);
  });

  it("ignores accounts the pool does not own", () => {
    // The regression that made the first version of this decoder read nothing
    // from mainnet. With the trader's side included, both mints net to zero —
    // a swap conserves tokens — and every transaction looks like a non-event.
    const decoded = decodeSolanaSwap(
      meta(
        [
          balance(1, SOL, "4000000000"),
          balance(2, USDC, "75000000", 6),
          balance(3, SOL, "1000000000", 9, TRADER),
          balance(4, USDC, "0", 6, TRADER),
        ],
        [
          balance(1, SOL, "5000000000"),
          balance(2, USDC, "1000000", 6),
          balance(3, SOL, "0", 9, TRADER),
          balance(4, USDC, "74000000", 6, TRADER),
        ]
      ),
      POOL,
      SOL,
      USDC
    )!;

    expect(decoded.amount0).toBe(1_000_000_000n);
    expect(decoded.zeroForOne).toBe(true);
  });

  it("credits only this pool's leg of a multi-hop route", () => {
    // A Jupiter route through two pools. Attributing the whole route to each
    // would double the day's volume on both.
    const otherPool = "3QYYvFWgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    const decoded = decodeSolanaSwap(
      meta(
        [
          balance(1, SOL, "4000000000"),
          balance(2, USDC, "75000000", 6),
          balance(5, SOL, "9000000000", 9, otherPool),
          balance(6, USDC, "500000000", 6, otherPool),
        ],
        [
          balance(1, SOL, "5000000000"),
          balance(2, USDC, "1000000", 6),
          balance(5, SOL, "1000000000", 9, otherPool),
          balance(6, USDC, "900000000", 6, otherPool),
        ]
      ),
      POOL,
      SOL,
      USDC
    )!;

    expect(decoded.amount0).toBe(1_000_000_000n);
    expect(decoded.amount1).toBe(74_000_000n);
  });

  it("sums several pool-owned accounts of the same mint", () => {
    // A pool can hold more than one vault per mint, and a fee account besides.
    const decoded = decodeSolanaSwap(
      meta(
        [balance(1, SOL, "1000000000"), balance(3, SOL, "500000000"), balance(2, USDC, "45000000", 6)],
        [balance(1, SOL, "1400000000"), balance(3, SOL, "700000000"), balance(2, USDC, "0", 6)]
      ),
      POOL,
      SOL,
      USDC
    )!;

    // 400m + 200m into the two SOL vaults.
    expect(decoded.amount0).toBe(600_000_000n);
    expect(decoded.zeroForOne).toBe(true);
  });

  it("counts a closed vault's whole balance as having left", () => {
    // A pool drained and closed is exactly the event worth not misreading as
    // "no movement".
    const decoded = decodeSolanaSwap(
      meta(
        [balance(1, SOL, "1000000000"), balance(2, USDC, "0", 6)],
        [balance(2, USDC, "74000000", 6)]
      ),
      POOL,
      SOL,
      USDC
    )!;

    expect(decoded.amount0).toBe(1_000_000_000n);
    expect(decoded.zeroForOne).toBe(false);
  });

  it("ignores a one-sided movement", () => {
    // A deposit or a withdrawal. Recorded as a swap it would invent a price
    // from a trade that set none.
    const decoded = decodeSolanaSwap(
      meta([balance(1, SOL, "1000000000")], [balance(1, SOL, "2000000000")]),
      POOL,
      SOL,
      USDC
    );

    expect(decoded).toBeNull();
  });

  it("ignores same-sign movement on both mints", () => {
    // Both sides growing is a two-sided liquidity add, not a trade.
    const decoded = decodeSolanaSwap(
      meta(
        [balance(1, SOL, "1000000000"), balance(2, USDC, "1000000", 6)],
        [balance(1, SOL, "2000000000"), balance(2, USDC, "2000000", 6)]
      ),
      POOL,
      SOL,
      USDC
    );

    expect(decoded).toBeNull();
  });

  it("ignores a failed transaction", () => {
    // The pool account still appears in one, and its balances still parse.
    const decoded = decodeSolanaSwap(
      meta(
        [balance(1, SOL, "5000000000"), balance(2, USDC, "1000000", 6)],
        [balance(1, SOL, "4000000000"), balance(2, USDC, "75000000", 6)],
        { InstructionError: [2, "Custom"] }
      ),
      POOL,
      SOL,
      USDC
    );

    expect(decoded).toBeNull();
  });

  it("ignores a transaction that merely read the pool", () => {
    // Another route quoting through this pool without trading it.
    const other = "4rJggoVMajEUtipev1XhSMjESYk8Zibz6CDHPtUe1mem";
    const decoded = decodeSolanaSwap(
      meta([balance(1, other, "100")], [balance(1, other, "200")]),
      POOL,
      SOL,
      USDC
    );

    expect(decoded).toBeNull();
  });

  it("reports a venue it cannot read, rather than tracking it silently", () => {
    // Some AMMs hold vaults under a shared program authority instead of under
    // the pool. Those decode to nothing here — forever — so discovery probes
    // once and drops them instead of following a pool that yields no swaps.
    const authorityOwned = meta(
      [balance(1, SOL, "4000000000", 9, "AuthorityPDA"), balance(2, USDC, "75000000", 6, "AuthorityPDA")],
      [balance(1, SOL, "5000000000", 9, "AuthorityPDA"), balance(2, USDC, "1000000", 6, "AuthorityPDA")]
    );

    expect(probeDecodable([authorityOwned], POOL, SOL, USDC)).toBe(false);
    expect(
      probeDecodable(
        [
          authorityOwned,
          meta(
            [balance(1, SOL, "4000000000"), balance(2, USDC, "75000000", 6)],
            [balance(1, SOL, "5000000000"), balance(2, USDC, "1000000", 6)]
          ),
        ],
        POOL,
        SOL,
        USDC
      )
    ).toBe(true);
  });

  it("treats an unchanged balance as no movement", () => {
    const decoded = decodeSolanaSwap(
      meta(
        [balance(1, SOL, "5000000000"), balance(2, USDC, "1000000", 6)],
        [balance(1, SOL, "5000000000"), balance(2, USDC, "1000000", 6)]
      ),
      POOL,
      SOL,
      USDC
    );

    expect(decoded).toBeNull();
  });
});
