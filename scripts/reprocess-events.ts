import { logger } from "../src/utils/logger.js";

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const chainArg = args.find((a) => a.startsWith("--chainId="));
  const chainId = chainArg ? chainArg.split("=")[1] : "base:mainnet";

  logger.info("[reprocess-events] starting historical raw event replay", {
    chainId,
    dryRun,
  });

  logger.info("[reprocess-events] finished replay simulation", { chainId });
}

main().catch((err) => {
  logger.error("[reprocess-events] error", { error: err.message });
  process.exit(1);
});
