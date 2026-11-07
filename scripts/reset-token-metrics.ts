import "dotenv/config";
import { PrismaClient } from "@prisma/client";

/**
 * Clears cached market metrics so the discovery page stops rendering numbers
 * from whatever provider the deployment used months ago.
 *
 * Switching `MARKET_DATA_PROVIDER` does not invalidate the `Token` table: the
 * sync only overwrites fields the new provider actually returns, so a token it
 * does not know keeps its old price and volume indefinitely. This is the
 * one-off that removes that history before the first pass of the new provider.
 *
 * Identity is untouched — only the metric columns and their timestamp.
 *
 * Deliberately standalone: it imports `@prisma/client` and nothing from `src/`,
 * so it runs from the runtime image where `scripts/` sits beside `dist/`.
 */
function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const chainArg = process.argv.find((arg) => arg.startsWith("--chainId="));
  const chainId = chainArg?.split("=")[1];

  const prisma = new PrismaClient();
  const where = chainId ? { chainId } : {};

  try {
    const count = await prisma.token.count({ where });

    if (dryRun) {
      log(
        `[reset-token-metrics] would clear metrics chain=${chainId ?? "all"} tokens=${count}`
      );
      return;
    }

    const { count: updated } = await prisma.token.updateMany({
      where,
      data: {
        priceUsd: null,
        priceChange5m: null,
        priceChange1h: null,
        priceChange6h: null,
        priceChange24h: null,
        volume24h: null,
        liquidityUsd: null,
        marketCapUsd: null,
        txnsBuys24h: null,
        txnsSells24h: null,
        metricsUpdatedAt: null,
      },
    });

    log(
      `[reset-token-metrics] cleared metrics chain=${chainId ?? "all"} updated=${updated}; next sync repopulates`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  process.stderr.write(
    `[reset-token-metrics] failed: ${error instanceof Error ? error.message : String(error)}\n`
  );
  process.exit(1);
});
