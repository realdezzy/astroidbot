import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import bs58 from "bs58";
import { decodePoolAccount, discriminator, SOLANA_POOL_LAYOUTS } from "../../../src/services/indexer/svm/poolLayouts.js";
import { decodeInstructionSwaps, type ParsedInstruction } from "../../../src/services/indexer/svm/instructionSwaps.js";

describe("Solana program accounts", () => {
  it("matches real Raydium accounts against independent pool API mint metadata", () => {
    // Public finalized account snapshots collected 2026-09-10 from Solana RPC.
    const rows = JSON.parse(readFileSync(new URL("../../fixtures/indexer/raydium-pools.json", import.meta.url), "utf8")) as { address: string; program: string; data: string; token0: string; token1: string }[];
    for (const row of rows) {
      const decoded = decodePoolAccount(row.program, Buffer.from(row.data, "base64"));
      expect(decoded, row.address).toMatchObject({ token0: row.token0, token1: row.token1 });
      expect(decoded?.vault0).not.toBe(decoded?.vault1);
    }
  });
  it("rejects an unrelated Anchor account under the same program", () => {
    expect(decodePoolAccount(SOLANA_POOL_LAYOUTS[1].program, Buffer.alloc(500))).toBeNull();
  });
});

describe("individual CPI swap attribution", () => {
  const program = SOLANA_POOL_LAYOUTS[1].program;
  const pool = { poolAddress: "pool", programId: program, vault0: "vault-x", vault1: "vault-y" };
  const instruction = (height = 2): ParsedInstruction => ({ programId: program, accounts: ["pool"], data: bs58.encode(discriminator("global", "swap_base_input")), stackHeight: height });
  const transfer = (source: string, destination: string, amount: string, height = 3): ParsedInstruction => ({
    programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", stackHeight: height,
    parsed: { type: "transfer", info: { source, destination, amount } },
  });
  it("preserves two opposite swaps through one pool instead of netting them to zero", () => {
    const swaps = decodeInstructionSwaps({
      transaction: { message: { instructions: [{ programId: "router" }] } },
      meta: { innerInstructions: [{ index: 0, instructions: [
        instruction(), transfer("user-x", "vault-x", "100"), transfer("vault-y", "user-y", "200"),
        instruction(), transfer("user-y", "vault-y", "200"), transfer("vault-x", "user-x", "100"),
      ] }] },
    }, pool);
    expect(swaps).toHaveLength(2);
    expect(swaps.map((s) => s.zeroForOne)).toEqual([true, false]);
    expect(swaps[0]?.instructionIndex).not.toBe(swaps[1]?.instructionIndex);
  });
  it("does not mistake a liquidity deposit for a swap", () => {
    expect(decodeInstructionSwaps({
      transaction: { message: { instructions: [{ ...instruction(1), data: bs58.encode(discriminator("global", "deposit")) }] } },
      meta: { innerInstructions: [{ index: 0, instructions: [transfer("x", "vault-x", "100", 2), transfer("y", "vault-y", "200", 2)] }] },
    }, pool)).toEqual([]);
  });
  it("fails closed when a recognized swap lacks one vault transfer", () => {
    expect(() => decodeInstructionSwaps({
      transaction: { message: { instructions: [instruction(1)] } },
      meta: { innerInstructions: [{ index: 0, instructions: [transfer("x", "vault-x", "100", 2)] }] },
    }, pool)).toThrow("incomplete vault transfers");
  });
});
