/**
 * Reports which stored wallet keys still decrypt under the current `AES_KEY`,
 * and optionally removes the ones that don't.
 *
 * Rotating `AES_KEY` makes every ciphertext written under the old one
 * unreadable. A wallet row whose key cannot be decrypted is worse than no row:
 * it appears in the UI, it can be selected for a trade, and it fails at the
 * moment of signing — after the user has committed to the trade.
 *
 * It verifies rather than assumes. `decrypt()` carries a fallback to a legacy
 * pre-HKDF derivation, so some rows written under an older scheme still read
 * fine and must not be deleted; the only way to know is to try each one.
 *
 *   npx tsx scripts/check-wallet-keys.ts            # report only
 *   npx tsx scripts/check-wallet-keys.ts --apply    # delete unreadable rows
 *
 * Dry by default: this deletes custody records, so the destructive path is
 * opt-in rather than the thing that happens if you forget a flag.
 */
import { ConfigManager } from "../src/config.js";
import { DatabaseService } from "../src/services/db.js";
import { decrypt } from "../src/utils/crypto.js";
import { logger } from "../src/utils/logger.js";

interface Unreadable {
  id: number;
  userId: number;
  chain: string;
  address: string;
  reason: string;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  ConfigManager.load();
  const db = DatabaseService.connect();

  const wallets = await db.prisma.wallet.findMany({
    select: { id: true, userId: true, chain: true, address: true, encryptedKey: true },
    orderBy: { id: "asc" },
  });

  const unreadable: Unreadable[] = [];
  let readable = 0;

  for (const wallet of wallets) {
    try {
      const key = decrypt(wallet.encryptedKey);
      // A decrypt that returns an empty string has "succeeded" without
      // producing a usable key, which signing would fail on just as surely.
      if (!key) throw new Error("decrypted to an empty string");
      readable++;
    } catch (error) {
      unreadable.push({
        id: wallet.id,
        userId: wallet.userId,
        chain: wallet.chain,
        address: wallet.address,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  logger.info("[check-wallet-keys] scanned", {
    total: wallets.length,
    readable,
    unreadable: unreadable.length,
  });

  for (const row of unreadable) {
    // The address is public; the key never leaves this process.
    logger.warn("[check-wallet-keys] unreadable", {
      id: row.id,
      userId: row.userId,
      chain: row.chain,
      address: row.address,
      reason: row.reason,
    });
  }

  if (unreadable.length === 0) {
    logger.info("[check-wallet-keys] every stored key decrypts; nothing to do");
  } else if (!apply) {
    logger.warn(
      `[check-wallet-keys] ${unreadable.length} unreadable row(s). Re-run with --apply to delete them.`
    );
  } else {
    // Trades reference wallets, so a bare delete violates the foreign key.
    // Reporting that rather than cascading is deliberate: destroying trade
    // history to tidy up a key rotation is not a call this script should make.
    const ids = unreadable.map((row) => row.id);
    const trades = await db.prisma.trade.count({ where: { walletId: { in: ids } } });
    if (trades > 0) {
      logger.error(
        `[check-wallet-keys] refusing to delete: ${trades} trade(s) reference these wallets. ` +
          `Decide what happens to that history first — this script will not discard it for you.`
      );
      process.exitCode = 1;
    } else {
      const { count } = await db.prisma.wallet.deleteMany({ where: { id: { in: ids } } });
      logger.info("[check-wallet-keys] deleted unreadable wallet rows", { count });
    }
  }

  await db.disconnect();
}

main().catch((error) => {
  logger.error("[check-wallet-keys] failed", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});
