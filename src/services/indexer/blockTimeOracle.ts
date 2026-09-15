import type { PublicClient } from "viem";

/**
 * Timestamps for blocks, without asking the chain about every one.
 *
 * The naive approach — `eth_getBlockByNumber` per swap's block — is what makes
 * a swap indexer unusable. A range with a few thousand swaps spans a few
 * thousand blocks, and even deduplicated and batched that is thousands of
 * responses per tick just to answer "roughly when did this happen".
 *
 * It only ever has to be *roughly*. The timestamp's whole job is to place a
 * swap in a 5-minute bucket, so accuracy to a few seconds is ample. So we
 * sample a bounded number of the blocks that actually produced a swap and
 * linearly interpolate between them: cost becomes constant in the size of the
 * range, and zero when the range held nothing.
 *
 * The error this introduces is the deviation of real block production from a
 * constant rate *within one sample interval*. Block times are near-constant on
 * every chain we index, and a misplaced swap lands in an adjacent bucket at
 * worst — it is never lost, double-counted, or mispriced, because the price
 * and volume come from the log itself.
 */
export class BlockTimeOracle {
  /** block -> unix ms, ascending by construction. */
  private samples: { block: bigint; ms: number }[] = [];

  constructor(
    private readonly client: PublicClient,
    /**
     * Ceiling on blocks actually read. 200 samples across a range of swaps
     * spanning 20k blocks is one sample per 100 blocks; for a 250ms-block L2
     * that is ~25 seconds of chain per interval, far finer than the 5-minute
     * bucket it feeds.
     */
    private readonly maxSamples = 200,
    private readonly concurrency = 50,
    private readonly strict = false
  ) {}

  /**
   * Samples exactly the blocks given, deduplicated.
   *
   * This is the cheap path, and the one ingestion uses. The timestamps exist
   * only to place a swap in a 5-minute bucket, so the only blocks worth asking
   * about are the ones a swap was actually found in — sampling the range they
   * happen to span buys nothing and costs one read per block scanned.
   *
   * Above `maxSamples` distinct blocks it falls back to an evenly-spaced
   * subset and interpolates between them: the bound on work is what keeps a
   * busy range from becoming a thousand round trips.
   */
  async primeBlocks(blocks: (bigint | null | undefined)[]): Promise<void> {
    const distinct = [...new Set(blocks.filter((b): b is bigint => b != null))].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0
    );

    if (distinct.length === 0) return;

    // Both endpoints are kept whatever the stride, so every other block in the
    // set interpolates rather than extrapolates.
    const wanted =
      distinct.length <= this.maxSamples
        ? distinct
        : (() => {
            const stride = Math.ceil(distinct.length / this.maxSamples);
            const subset = distinct.filter((_, i) => i % stride === 0);
            const last = distinct[distinct.length - 1]!;
            if (subset[subset.length - 1] !== last) subset.push(last);
            return subset;
          })();

    await this.fetchSamples(wanted);
  }

  /** Fetches and records any of `wanted` not already sampled. */
  private async fetchSamples(wanted: bigint[]): Promise<void> {
    const have = new Set(this.samples.map((s) => s.block));
    const missing = wanted.filter((b) => !have.has(b));

    for (let i = 0; i < missing.length; i += this.concurrency) {
      const slice = missing.slice(i, i + this.concurrency);
      const fetched = await Promise.all(
        slice.map(async (block) => {
          try {
            const header = await this.client.getBlock({ blockNumber: block });
            return { block, ms: Number(header.timestamp) * 1000 };
          } catch (error) {
            if (this.strict) throw error;
            // A missing sample only widens the interval either side of it.
            return null;
          }
        })
      );

      for (const sample of fetched) {
        if (sample) this.samples.push(sample);
      }
    }

    this.samples.sort((a, b) => (a.block < b.block ? -1 : a.block > b.block ? 1 : 0));
  }

  /**
   * Interpolated timestamp for a block, or `fallback` if nothing was sampled.
   *
   * Binary search rather than a scan: this is called once per swap, and a
   * linear scan over 200 samples per call is the kind of quiet O(n·m) that
   * only shows up under real volume.
   */
  timeOf(block: bigint, fallback: number = Date.now()): number {
    if (this.samples.length === 0) return fallback;

    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    if (block <= first.block) return first.ms;
    if (block >= last.block) return last.ms;

    let lo = 0;
    let hi = this.samples.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.samples[mid]!.block <= block) lo = mid;
      else hi = mid;
    }

    const left = this.samples[lo]!;
    const right = this.samples[hi]!;

    const blockSpan = right.block - left.block;
    if (blockSpan === 0n) return left.ms;

    const offset = Number(block - left.block) / Number(blockSpan);
    return left.ms + offset * (right.ms - left.ms);
  }

  get sampleCount(): number {
    return this.samples.length;
  }
}
