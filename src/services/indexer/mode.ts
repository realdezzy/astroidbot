import { ConfigManager } from "../../config.js";

/**
 * Which process ingests market data.
 *
 * Deliberately not a boolean. "Is the indexer enabled" and "does *this*
 * process run it" are different questions, and answering both with one flag is
 * how a deployment ends up with two containers ingesting the same chains —
 * which is safe (the per-chain Redis lock sees to that) but is two containers
 * doing one container's work, and looks like nothing at all from the outside.
 *
 * Every process in a deployment must agree on this value. Compose pins it for
 * both services rather than leaving it to an env file.
 */
export type IndexerMode = "off" | "inline" | "standalone";

export function indexerMode(): IndexerMode {
  return ConfigManager.getInstance().config.INDEXER_MODE;
}

/** True when this deployment ingests at all, wherever it does so. */
export function indexingEnabled(): boolean {
  return indexerMode() !== "off";
}

/**
 * True when the trading cycle should also drive ingestion.
 *
 * Only in `inline`. In `standalone` the dedicated indexer process owns it, and
 * this returning true would put the heaviest RPC consumer in the codebase back
 * on the same event loop as trade execution — the thing splitting it out was
 * meant to prevent.
 */
export function shouldIngestInline(): boolean {
  return indexerMode() === "inline";
}

/**
 * Rejects a configuration in which the standalone indexer process shouldn't be
 * running at all.
 *
 * Loud at startup, because both wrong answers are silent later: `inline` means
 * the API is ingesting too, and `off` means a dedicated indexer container that
 * indexes nothing — which on a discovery page is indistinguishable from a
 * chain where nobody is trading.
 */
export function assertStandaloneProcess(): void {
  const mode = indexerMode();
  if (mode === "standalone") return;

  if (mode === "off") {
    throw new Error(
      "INDEXER_MODE=off, but this is the standalone indexer process. " +
        "Set INDEXER_MODE=standalone, or stop running this container."
    );
  }

  throw new Error(
    "INDEXER_MODE=inline means the API process ingests on its own tick. " +
      "Running this process too would have both containers indexing the same chains. " +
      "Set INDEXER_MODE=standalone on every process in the deployment."
  );
}
