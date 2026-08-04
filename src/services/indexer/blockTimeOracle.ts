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
 * sample a bounded number of blocks across the range and linearly interpolate
 * between them: cost becomes constant in the size of the range rather than
 * linear in it.
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
     * Ceiling on sampled blocks per range. 200 across a 20k-block range is one
     * sample per 100 blocks; for a 250ms-block L2 that is ~25 seconds of chain
     * per interval, far finer than the 5-minute bucket it feeds.
     */
    private readonly maxSamples = 200,
    private readonly concurrency = 50
  ) {}

  /**
   * Samples the range so `timeOf` can answer for any block within it.
   *
   * Both endpoints are always sampled, so interpolation is never extrapolation
   * for blocks inside the range.
   */
  async prime(from: bigint, to: bigint): Promise<void> {
    if (to < from) return;

    const span = to - from;
    const stride =
      span <= BigInt(this.maxSamples)
        ? 1n
        : span / BigInt(this.maxSamples) + 1n;

    const wanted: bigint[] = [];
    for (let block = from; block < to; block += stride) wanted.push(block);
    wanted.push(to);

    const missing = wanted.filter((b) => !this.samples.some((s) => s.block === b));

    for (let i = 0; i < missing.length; i += this.concurrency) {
      const slice = missing.slice(i, i + this.concurrency);
      const fetched = await Promise.all(
        slice.map(async (block) => {
          try {
            const header = await this.client.getBlock({ blockNumber: block });
            return { block, ms: Number(header.timestamp) * 1000 };
          } catch {
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
