import { discoverPumpCurves } from "./pumpCurve.js";
import bs58 from "bs58";
import { DatabaseService } from "../../db.js";
import { decodePoolAccount, discriminator, SOLANA_POOL_LAYOUTS } from "./poolLayouts.js";

type Rpc = <T>(method: string, params: unknown[]) => Promise<T>;
type Account = { owner: string; data: [string, string] };

/** Partition by a vault key byte, not a mint: popular mints otherwise make huge shards. */
export async function discoverSolanaPrograms(chainId: string, rpc: Rpc, quoteMints: Set<string>): Promise<number> {
  const db = DatabaseService.getInstance().prisma;
  const cursor = await db.indexerCursor.findUnique({ where: { chainId } });
  const state = (cursor?.forwardState ?? {}) as { partition?: number };
  const start = state.partition ?? 0;
  let discovered = 0;
  for (const layout of SOLANA_POOL_LAYOUTS) {
    for (let step = 0; step < 4; step++) {
      const partition = (start + step) % 256;
      const filters: unknown[] = [{ memcmp: { offset: layout.vault0, bytes: bs58.encode(Uint8Array.of(partition)) } }];
      if (layout.account) filters.push({ memcmp: { offset: 0, bytes: bs58.encode(discriminator("account", layout.account)) } });
      if (layout.size) filters.push({ dataSize: layout.size });
      const accounts = await rpc<{ pubkey: string; account: Account }[]>("getProgramAccounts", [layout.program, {
        encoding: "base64", commitment: "finalized", filters,
        dataSlice: { offset: 0, length: Math.max(layout.mint0, layout.mint1, layout.vault0, layout.vault1) + 32 },
      }]);
      if (!Array.isArray(accounts)) throw new Error(`Missing ${layout.dexId} pool snapshot`);
      for (const { pubkey, account } of accounts) {
        if (account.owner !== layout.program) throw new Error("Unexpected pool account owner");
        const decoded = decodePoolAccount(account.owner, Buffer.from(account.data[0], "base64"));
        if (!decoded) throw new Error(`Unrecognised ${layout.dexId} pool layout`);
        const existing = await db.indexedPool.findUnique({ where: { chainId_poolAddress: { chainId, poolAddress: pubkey } } });
        if (existing) {
          await db.indexedPool.update({ where: { id: existing.id }, data: { programId: decoded.programId, vault0: decoded.vault0, vault1: decoded.vault1 } });
          continue;
        }
        const mints = await rpc<{ value: ({ data?: { parsed?: { info?: { decimals?: number } } } } | null)[] }>("getMultipleAccounts", [[decoded.token0, decoded.token1], { encoding: "jsonParsed", commitment: "finalized" }]);
        const decimals = mints.value?.map((a) => a?.data?.parsed?.info?.decimals);
        if (decimals?.length !== 2 || decimals.some((d) => d == null || !Number.isInteger(d) || d < 0 || d > 36)) throw new Error(`Missing mint metadata for ${pubkey}`);
        const quoteToken = quoteMints.has(decoded.token1) ? decoded.token1 : quoteMints.has(decoded.token0) ? decoded.token0 : decoded.token1;
        const baseToken = quoteToken === decoded.token0 ? decoded.token1 : decoded.token0;
        await db.indexedPool.upsert({ where: { chainId_poolAddress: { chainId, poolAddress: pubkey } },
          create: { chainId, poolAddress: pubkey, ...decoded, decimals0: decimals[0]!, decimals1: decimals[1]!, baseToken, quoteToken },
          update: { programId: decoded.programId, vault0: decoded.vault0, vault1: decoded.vault1 },
        });
        // Identity is the mint; unavailable display metadata must not block discovery.
        await db.indexedToken.upsert({ where: { chainId_contractId: { chainId, contractId: baseToken } },
          create: { chainId, contractId: baseToken, dexId: decoded.dexId, symbol: baseToken.slice(0, 8), name: baseToken, decimals: baseToken === decoded.token0 ? decimals[0]! : decimals[1]! }, update: {},
        });
        discovered++;
      }
    }
  }
  for (let step = 0; step < 4; step++) discovered += await discoverPumpCurves(chainId, rpc, (start + step) % 256);
  await db.indexerCursor.update({ where: { chainId }, data: { forwardState: { ...state, partition: (start + 4) % 256 } } });
  return discovered;
}
