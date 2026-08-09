import { describe, it, expect } from "vitest";
import { parseUnits } from "viem";
import { toDecimalString } from "../../src/utils/decimal.js";

describe("toDecimalString", () => {
  it("passes through ordinary decimal values unchanged", () => {
    expect(toDecimalString(1)).toBe("1");
    expect(toDecimalString(0.1)).toBe("0.1");
    expect(toDecimalString(1234.5678)).toBe("1234.5678");
    expect(toDecimalString(0)).toBe("0");
    expect(toDecimalString(-2.5)).toBe("-2.5");
  });

  it("expands the exponential notation String() produces for small magnitudes", () => {
    // String(0.0000001) === "1e-7", which parseUnits rejects outright.
    expect(toDecimalString(0.0000001)).toBe("0.0000001");
    expect(toDecimalString(1e-18)).toBe("0.000000000000000001");
    expect(toDecimalString(-1e-7)).toBe("-0.0000001");
    expect(toDecimalString(1.5e-7)).toBe("0.00000015");
  });

  it("expands the exponential notation String() produces for large magnitudes", () => {
    expect(toDecimalString(1e21)).toBe("1000000000000000000000");
    expect(toDecimalString(1.234e22)).toBe("12340000000000000000000");
  });

  it("rejects non-finite values rather than emitting a bogus amount", () => {
    expect(() => toDecimalString(NaN)).toThrow();
    expect(() => toDecimalString(Infinity)).toThrow();
  });

  it("converts to exact wei where toFixed(18) would leak float representation error", () => {
    // The bug this exists to prevent: (0.1).toFixed(18) is
    // "0.100000000000000006", so parseUnits would produce 6 wei too many.
    expect((0.1).toFixed(18)).toBe("0.100000000000000006");
    expect(parseUnits(toDecimalString(0.1), 18)).toBe(100000000000000000n);
    expect(parseUnits(toDecimalString(1.5), 18)).toBe(1500000000000000000n);
    expect(parseUnits(toDecimalString(0.000001), 6)).toBe(1n);
  });

  it("survives a round trip through parseUnits for a 6-decimal token", () => {
    expect(parseUnits(toDecimalString(1234.5678), 6)).toBe(1234567800n);
  });
});
