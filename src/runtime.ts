import https from "node:https";
import tls from "node:tls";
import axios from "axios";
import { logger } from "./utils/logger.js";
import { DatabaseService } from "./services/db.js";

/**
 * Process-level setup shared by every entrypoint.
 *
 * There is more than one process now — `src/index.ts` (API, Telegram, trading
 * cycle, queue workers) and `src/indexer.ts` (market-data ingestion) — and
 * these two steps are the ones neither can skip. They lived inside
 * `bootstrap()` when there was only one process; leaving them there would have
 * meant the indexer either dragged in Telegram and the Stacks DEX SDKs to get
 * them, or quietly ran without them.
 *
 * The second failure would have been the expensive one: RPC endpoints behind
 * Cloudflare reject Node's default TLS fingerprint, and an indexer that can't
 * read logs looks like a chain with no swaps rather than like a broken client.
 */

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const BROWSER_CIPHERS =
  "ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384";

let hardened = false;

/**
 * Makes all outbound HTTP in this process look like a browser.
 *
 * Patches `tls.DEFAULT_CIPHERS`, `axios.defaults` and `globalThis.fetch`
 * globally, so every HTTP client anywhere in the process inherits it —
 * including viem's transport, which is how the indexer talks to RPC.
 *
 * Idempotent: calling it twice would wrap `fetch` in itself.
 */
export function hardenOutboundHttp(): void {
  if (hardened) return;
  hardened = true;

  // Node's default cipher order triggers Cloudflare alert 40 on several of the
  // upstream APIs this codebase talks to.
  tls.DEFAULT_CIPHERS = BROWSER_CIPHERS;

  axios.defaults.httpsAgent = new https.Agent({
    ciphers: tls.DEFAULT_CIPHERS,
    honorCipherOrder: true,
    minVersion: "TLSv1.2",
  });
  axios.defaults.headers.common["User-Agent"] = BROWSER_UA;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = function (input, init) {
    if (input instanceof Request) {
      if (!input.headers.has("User-Agent")) {
        try {
          input.headers.set("User-Agent", BROWSER_UA);
        } catch {
          // A Request built from an immutable Headers instance can't be
          // mutated in place; rebuild it rather than dropping the header.
          const newHeaders = new Headers(input.headers);
          newHeaders.set("User-Agent", BROWSER_UA);
          return originalFetch.call(this, new Request(input, { headers: newHeaders }), init);
        }
      }
      return originalFetch.call(this, input, init);
    }

    const newInit = { ...init };
    const headers = new Headers(newInit.headers);
    if (!headers.has("User-Agent")) headers.set("User-Agent", BROWSER_UA);
    newInit.headers = headers;
    return originalFetch.call(this, input, newInit);
  };
}

/**
 * Logs unhandled rejections instead of letting them take the process down.
 *
 * The Bitflow SDK lazily initialises and 404s when its upstream is down; that
 * is a degraded integration, not a reason to stop trading on other DEXs.
 */
export function installProcessGuards(): void {
  process.on("unhandledRejection", (reason) => {
    if (reason instanceof Error && reason.message?.includes("HTTP error! status: 404")) {
      logger.warn("Bitflow SDK initialization failed (404), continuing without Bitflow integration");
      return;
    }
    logger.error("Unhandled rejection", {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });
}

/**
 * Connects to Postgres and refuses to continue without it.
 *
 * Exiting beats limping: every surface this process serves reads from the
 * database on its first request, so a process that starts without one only
 * converts a clear startup failure into a stream of confusing 500s.
 */
export async function connectDatabase(): Promise<void> {
  await DatabaseService.connect();
  const db = DatabaseService.getInstance();

  if (!(await db.healthCheck())) {
    logger.error("Database health check failed. Exiting.");
    logger.error("Prisma migration check: run 'npx prisma migrate dev' or 'npx prisma migrate deploy'");
    process.exit(1);
  }

  try {
    await db.prisma.$queryRaw`SELECT 1 FROM "User" LIMIT 1`;
  } catch {
    logger.warn("User table not found — may need migrations. Run: npx prisma migrate deploy");
  }
}
