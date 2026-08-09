import { describe, it, expect } from "vitest";
import { bucketStartOf, BUCKET_MS } from "../../../src/services/indexer/types.js";

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
