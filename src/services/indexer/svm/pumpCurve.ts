import { PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import bs58 from "bs58";
import fields from "./pumpTradeFields.json" with { type: "json" };
import { DatabaseService } from "../../db.js";

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const WSOL = "So11111111111111111111111111111111111111112";
const discriminator = (name: string) => createHash("sha256").update(name).digest().subarray(0, 8);
const ZERO = "11111111111111111111111111111111";
type Rpc = <T>(method: string, params: unknown[]) => Promise<T>;

/** Active curves are discovered independently of Jupiter and migrated AMM pools. */
export async function discoverPumpCurves(chainId: string, rpc: Rpc, partition: number): Promise<number> {
  const accounts = await rpc<{ pubkey: string; account: { data: [string, string] } }[]>("getProgramAccounts", [PUMP_PROGRAM, {
    encoding: "base64", commitment: "finalized", filters: [
      { memcmp: { offset: 0, bytes: bs58.encode(discriminator("account:BondingCurve")) } },
      { memcmp: { offset: 48, bytes: bs58.encode(Uint8Array.of(0)) } },
      { memcmp: { offset: 49, bytes: bs58.encode(Uint8Array.of(partition)) } },
    ],
  }]);
  const db = DatabaseService.getInstance().prisma;
  let count = 0;
  for (const { pubkey, account } of accounts) {
    const existing = await db.indexedPool.findUnique({ where: { chainId_poolAddress: { chainId, poolAddress: pubkey } } });
    if (existing) continue;
    const data = Buffer.from(account.data[0], "base64");
    const quote = data.length >= 115 ? bs58.encode(data.subarray(83, 115)) : ZERO;
    const quoteMint = quote === ZERO ? WSOL : quote;
    const owned = [];
    for (const programId of ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]) {
      const result = await rpc<{ value: { pubkey: string; account: { data: { parsed: { info: { mint: string; tokenAmount: { decimals: number } } } } } }[] }>("getTokenAccountsByOwner", [pubkey, { programId }, { encoding: "jsonParsed", commitment: "finalized" }]);
      owned.push(...result.value);
    }
    const base = owned.find((a) => {
      const mint = a.account.data.parsed.info.mint;
      const [curve] = PublicKey.findProgramAddressSync([Buffer.from("bonding-curve"), new PublicKey(mint).toBuffer()], new PublicKey(PUMP_PROGRAM));
      return mint !== quoteMint && curve.toBase58() === pubkey;
    });
    if (!base) continue;
    const token0 = base.account.data.parsed.info.mint;
    const decimals0 = base.account.data.parsed.info.tokenAmount.decimals;
    const quoteAccount = owned.find((a) => a.account.data.parsed.info.mint === quoteMint);
    const decimals1 = quoteMint === WSOL ? 9 : quoteAccount?.account.data.parsed.info.tokenAmount.decimals;
    if (decimals1 == null) throw new Error("Pump quote mint metadata unavailable");
    await db.indexedPool.upsert({ where: { chainId_poolAddress: { chainId, poolAddress: pubkey } }, create: {
      chainId, poolAddress: pubkey, programId: PUMP_PROGRAM, dexId: "pumpfun", token0, token1: quoteMint,
      decimals0, decimals1, baseToken: token0, quoteToken: quoteMint, vault0: base.pubkey, vault1: quoteAccount?.pubkey ?? pubkey,
    }, update: {} });
    await db.indexedToken.upsert({ where: { chainId_contractId: { chainId, contractId: token0 } }, create: {
      chainId, contractId: token0, dexId: "pumpfun", decimals: decimals0, symbol: token0.slice(0, 8), name: token0,
    }, update: {} });
    count++;
  }
  return count;
}

/** Decode each authenticated Pump TradeEvent, preserving multiple trades per transaction. */
export function decodePumpTrades(logs: string[], mint: string, quoteMint: string) {
  const stack: string[] = [];
  const swaps: { amount0: bigint; amount1: bigint; zeroForOne: boolean; instructionIndex: number }[] = [];
  for (const [index, line] of logs.entries()) {
    const invoke = /^Program (\w+) invoke \[\d+\]$/.exec(line);
    if (invoke) { stack.push(invoke[1]!); continue; }
    if (/^Program \w+ (success|failed:)/.test(line)) { stack.pop(); continue; }
    if (stack.at(-1) !== PUMP_PROGRAM || !line.startsWith("Program data: ")) continue;
    const data = Buffer.from(line.slice(14), "base64");
    if (!data.subarray(0, 8).equals(discriminator("event:TradeEvent"))) continue;
    const values: Record<string, string | bigint | boolean> = {};
    let offset = 8;
    for (const field of fields) {
      // Historical event versions end before newer appended fields.
      if (offset === data.length) break;
      const type = field.type;
      let size: number;
      if (typeof type === "string") {
        size = type === "pubkey" ? 32 : type === "bool" ? 1 : type === "string" ? 4 + data.readUInt32LE(offset) : 8;
        if (offset + size > data.length) throw new Error("Truncated Pump trade event");
        values[field.name] = type === "pubkey" ? bs58.encode(data.subarray(offset, offset + size))
          : type === "bool" ? data[offset] === 1 : type === "string" ? data.subarray(offset + 4, offset + size).toString()
          : type === "i64" ? data.readBigInt64LE(offset) : data.readBigUInt64LE(offset);
      } else {
        // Shareholder is (pubkey,u16), per the official IDL.
        size = 4 + data.readUInt32LE(offset) * 34;
        if (offset + size > data.length) throw new Error("Truncated Pump shareholders");
      }
      offset += size;
    }
    if (values.mint !== mint) continue;
    const eventQuote = values.quote_mint === ZERO || values.quote_mint == null ? WSOL : values.quote_mint;
    if (eventQuote !== quoteMint) throw new Error("Pump quote mint mismatch");
    const amount0 = values.token_amount;
    const amount1 = values.quote_amount ?? values.sol_amount;
    if (typeof amount0 !== "bigint" || typeof amount1 !== "bigint" || typeof values.is_buy !== "boolean") throw new Error("Missing Pump trade amounts");
    swaps.push({ amount0, amount1, zeroForOne: !values.is_buy, instructionIndex: index });
  }
  if (logs.some((line) => line.toLowerCase().includes("log truncated"))) throw new Error("Transaction logs truncated");
  return swaps;
}
