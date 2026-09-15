import { isSwapInstruction } from "./poolLayouts.js";

export interface ParsedInstruction {
  programId: string;
  accounts?: string[];
  data?: string;
  stackHeight?: number | null;
  parsed?: { type?: string; info?: { source?: string; destination?: string; amount?: string; tokenAmount?: { amount?: string } } };
}
export interface ParsedSwapTransaction {
  transaction?: { message?: { instructions?: ParsedInstruction[] } };
  meta?: { err?: unknown; innerInstructions?: { index: number; instructions: ParsedInstruction[] }[] };
}
const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);

/** One result per invocation, including repeated visits to the same pool. */
export function decodeInstructionSwaps(tx: ParsedSwapTransaction, pool: { poolAddress: string; programId: string; vault0: string; vault1: string }) {
  if (tx.meta?.err) return [];
  const out: { amount0: bigint; amount1: bigint; zeroForOne: boolean; instructionIndex: number }[] = [];
  for (const [topIndex, root] of (tx.transaction?.message?.instructions ?? []).entries()) {
    const inner = tx.meta?.innerInstructions?.find((g) => g.index === topIndex)?.instructions ?? [];
    const instructions = [{ ...root, stackHeight: 1 }, ...inner];
    for (const [index, ix] of instructions.entries()) {
      if (ix.programId !== pool.programId || !ix.accounts?.includes(pool.poolAddress) || !ix.data || !isSwapInstruction(ix.programId, ix.data)) continue;
      if (ix.stackHeight == null) throw new Error("Missing CPI stack height; cannot attribute swap safely");
      const deltas = [0n, 0n];
      for (const child of instructions.slice(index + 1)) {
        if (child.stackHeight != null && child.stackHeight <= ix.stackHeight) break;
        if (!TOKEN_PROGRAMS.has(child.programId) || !["transfer", "transferChecked"].includes(child.parsed?.type ?? "")) continue;
        const info = child.parsed!.info;
        const amount = info?.amount ?? info?.tokenAmount?.amount;
        if (amount == null) throw new Error("Missing token transfer amount");
        for (const [i, vault] of [pool.vault0, pool.vault1].entries()) {
          if (info?.destination === vault) deltas[i]! += BigInt(amount);
          if (info?.source === vault) deltas[i]! -= BigInt(amount);
        }
      }
      const [a, b] = deltas as [bigint, bigint];
      if (a === 0n || b === 0n || (a > 0n) === (b > 0n)) throw new Error("Swap invocation has incomplete vault transfers");
      out.push({ amount0: a < 0n ? -a : a, amount1: b < 0n ? -b : b, zeroForOne: a > 0n, instructionIndex: topIndex * 1000 + index });
    }
  }
  return out;
}
