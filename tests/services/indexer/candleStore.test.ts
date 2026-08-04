import { describe, it, expect } from "vitest";
import { CandleAccumulator } from "../../../src/services/indexer/candleStore.js";
import { bucketStartOf, BUCKET_MS } from "../../../src/services/indexer/types.js";

const T0 = new Date("2026-08-02T12:00:00.000Z");

describe("bucketStartOf", () => {
  it("floors to the 5-minute boundary", () => {
    expect(bucketStartOf(Date.parse("2026-08-02T12:03:59.999Z")).toISOString()).toBe(
      "2026-08-02T12:00:00.000Z"
    );
    expect(bucketStartOf(Date.parse("2026-08-02T12:05:00.000Z")).toISOString()).toBe(
      "2026-08-02T12:05:00.000Z"
    );
  });

  it("uses a bucket width that divides the hour evenly", () => {
    // Windows are built by counting buckets, so a width that doesn't divide an
    // hour would make "1H" and "6H" drift out of alignment over time.
    expect(3_600_000 % BUCKET_MS).toBe(0);
  });
});

describe("CandleAccumulator", () => {
  it("records OHLC in application order", () => {
    const acc = new CandleAccumulator();
    acc.add(1, T0, 100, 10, true);
    acc.add(1, T0, 120, 10, true);
    acc.add(1, T0, 80, 10, false);
    acc.add(1, T0, 90, 10, false);

    const [candle] = acc.values();
    expect(candle).toMatchObject({ open: 100, high: 120, low: 80, close: 90 });
  });

  it("sums volume and counts buys and sells separately", () => {
    const acc = new CandleAccumulator();
    acc.add(1, T0, 1, 250, true);
    acc.add(1, T0, 1, 750, false);
    acc.add(1, T0, 1, 100, true);

    const [candle] = acc.values();
    expect(candle!.volumeUsd).toBe(1100);
    expect(candle!.buys).toBe(2);
    expect(candle!.sells).toBe(1);
  });

  it("keeps pools and buckets separate", () => {
    const acc = new CandleAccumulator();
    const later = new Date(T0.getTime() + BUCKET_MS);

    acc.add(1, T0, 10, 1, true);
    acc.add(2, T0, 20, 1, true);
    acc.add(1, later, 30, 1, true);

    expect(acc.size).toBe(3);
  });

  it("does not let an unpriceable swap drag the low to zero", () => {
    // A swap we can't price still counts as activity, but treating its price
    // as 0 would make the candle's low zero and the percentage change -100%.
    const acc = new CandleAccumulator();
    acc.add(1, T0, 100, 5, true);
    acc.add(1, T0, 0, 0, true);
    acc.add(1, T0, 110, 5, true);

    const [candle] = acc.values();
    expect(candle!.low).toBe(100);
    expect(candle!.high).toBe(110);
    expect(candle!.close).toBe(110);
    expect(candle!.buys).toBe(3);
  });

  it("recovers an open price when the first swap of a bucket was unpriceable", () => {
    const acc = new CandleAccumulator();
    acc.add(1, T0, 0, 0, true);
    acc.add(1, T0, 42, 1, true);

    const [candle] = acc.values();
    expect(candle!.open).toBe(42);
    expect(candle!.low).toBe(42);
  });
});
