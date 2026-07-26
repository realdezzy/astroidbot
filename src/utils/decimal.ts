// Converts a JS number to a plain decimal string suitable for viem's
// parseUnits, which rejects exponential notation.
//
// Deliberately built on String(amount) — JavaScript's shortest round-trip
// representation — rather than toFixed(decimals). For an 18-decimal token,
// (0.1).toFixed(18) is "0.100000000000000006": toFixed exposes the double's
// binary representation error as real digits, so the caller would send
// 100000000000000006 wei instead of the intended 1e17. String(0.1) is "0.1",
// which parses to exactly 1e17.
//
// Only the exponential forms String() produces for very small/large magnitudes
// (|x| < 1e-6 or >= 1e21) need expanding.
export function toDecimalString(amount: number): string {
  if (!Number.isFinite(amount)) {
    throw new Error(`Cannot convert non-finite number to a decimal string: ${amount}`);
  }

  const s = String(amount);
  if (!s.includes("e") && !s.includes("E")) return s;

  const [mantissa, expPart] = s.split(/e/i);
  const exp = Number(expPart);
  const negative = mantissa!.startsWith("-");
  const unsigned = negative ? mantissa!.slice(1) : mantissa!;
  const [intPart = "", fracPart = ""] = unsigned.split(".");
  const digits = intPart + fracPart;

  // Where the decimal point lands within `digits` after applying the exponent.
  const pointPos = intPart.length + exp;

  let out: string;
  if (pointPos <= 0) {
    out = "0." + "0".repeat(-pointPos) + digits;
  } else if (pointPos >= digits.length) {
    out = digits + "0".repeat(pointPos - digits.length);
  } else {
    out = digits.slice(0, pointPos) + "." + digits.slice(pointPos);
  }

  return negative ? `-${out}` : out;
}
