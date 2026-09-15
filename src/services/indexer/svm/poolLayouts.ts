import { createHash } from "node:crypto";
import bs58 from "bs58";

/** Offsets include Anchor's eight-byte discriminator. Sources: see Docs/indexer.md. */
export const SOLANA_POOL_LAYOUTS = [
  { dexId: "raydium-v4", program: "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8", size: 752, mint0: 400, mint1: 432, vault0: 336, vault1: 368, account: null, swaps: ["9", "11"] },
  { dexId: "raydium-cpmm", program: "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C", size: null, mint0: 168, mint1: 200, vault0: 72, vault1: 104, account: "PoolState", swaps: ["swap_base_input", "swap_base_output"] },
  { dexId: "raydium-clmm", program: "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK", size: null, mint0: 73, mint1: 105, vault0: 137, vault1: 169, account: "PoolState", swaps: ["swap", "swap_v2"] },
  { dexId: "orca-whirlpool", program: "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc", size: null, mint0: 101, mint1: 181, vault0: 133, vault1: 213, account: "Whirlpool", swaps: ["swap", "swap_v2", "two_hop_swap", "two_hop_swap_v2"] },
  { dexId: "meteora-dlmm", program: "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", size: null, mint0: 88, mint1: 120, vault0: 152, vault1: 184, account: "LbPair", swaps: ["swap", "swap2", "swap_exact_out", "swap_exact_out2", "swap_with_price_impact", "swap_with_price_impact2"] },
  { dexId: "pumpswap", program: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", size: null, mint0: 43, mint1: 75, vault0: 139, vault1: 171, account: "Pool", swaps: ["buy", "sell", "buy_exact_quote_in"] },
] as const;

export function discriminator(namespace: "account" | "global", name: string): Buffer {
  return createHash("sha256").update(`${namespace}:${name}`).digest().subarray(0, 8);
}

export function decodePoolAccount(program: string, data: Buffer) {
  const layout = SOLANA_POOL_LAYOUTS.find((l) => l.program === program);
  if (!layout || data.length < Math.max(layout.mint0, layout.mint1, layout.vault0, layout.vault1) + 32) return null;
  if (layout.account && !data.subarray(0, 8).equals(discriminator("account", layout.account))) return null;
  const key = (offset: number) => bs58.encode(data.subarray(offset, offset + 32));
  return { dexId: layout.dexId, programId: program, token0: key(layout.mint0), token1: key(layout.mint1), vault0: key(layout.vault0), vault1: key(layout.vault1) };
}

export function isSwapInstruction(program: string, encoded: string): boolean {
  const layout = SOLANA_POOL_LAYOUTS.find((l) => l.program === program);
  if (!layout) return false;
  const bytes = Buffer.from(bs58.decode(encoded));
  return layout.swaps.some((name) => /^\d+$/.test(name)
    ? bytes[0] === Number(name) : bytes.subarray(0, 8).equals(discriminator("global", name)));
}
