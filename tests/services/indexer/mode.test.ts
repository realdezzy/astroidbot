import { describe, it, expect, beforeEach } from "vitest";
import { ConfigManager } from "../../../src/config.js";
import {
  indexerMode,
  indexingEnabled,
  shouldIngestInline,
  assertStandaloneProcess,
} from "../../../src/services/indexer/mode.js";

/**
 * Ingestion moved into its own process (src/indexer.ts, its own container), so
 * "is the indexer on" and "does *this* process run it" stopped being the same
 * question. These tests pin the answers, because getting them wrong is either
 * silent duplicate work or silently no data at all.
 */

function loadWithMode(mode?: string): void {
  process.env.ASTROIDBOT_DATABASE_URL = "postgresql://localhost:5432/test";
  process.env.AES_KEY = "testkey";
  process.env.JWT_SECRET = "change-me-in-production-to-32-char-min-xyz";
  if (process.env.TELEGRAM_WEBHOOK_URL === "") delete process.env.TELEGRAM_WEBHOOK_URL;
  if (process.env.VELUMX_RELAYER_URL === "") delete process.env.VELUMX_RELAYER_URL;

  if (mode === undefined) delete process.env.INDEXER_MODE;
  else process.env.INDEXER_MODE = mode;

  ConfigManager.reset();
  ConfigManager.load();
}

describe("indexer mode", () => {
  beforeEach(() => {
    delete process.env.INDEXER_MODE;
  });

  it("defaults to inline so a single process still indexes", () => {
    // The default has to keep `npm start` self-sufficient: a developer who
    // sets nothing should get working discovery data from one command.
    loadWithMode(undefined);
    expect(indexerMode()).toBe("inline");
    expect(shouldIngestInline()).toBe(true);
  });

  it("stops the trading cycle ingesting once a dedicated process owns it", () => {
    loadWithMode("standalone");
    expect(shouldIngestInline()).toBe(false);
    // Still enabled — just not here. Conflating the two is what this
    // distinction exists to prevent.
    expect(indexingEnabled()).toBe(true);
  });

  it("treats off as nobody ingesting", () => {
    loadWithMode("off");
    expect(indexingEnabled()).toBe(false);
    expect(shouldIngestInline()).toBe(false);
  });

  it("rejects an unknown mode at load rather than falling back", () => {
    expect(() => loadWithMode("maybe")).toThrow();
  });

  describe("assertStandaloneProcess", () => {
    it("passes in standalone", () => {
      loadWithMode("standalone");
      expect(() => assertStandaloneProcess()).not.toThrow();
    });

    it("refuses to start alongside an inline API process", () => {
      // Both ingesting is safe but wasteful, and invisible from the outside —
      // so it fails at startup where someone will see it.
      loadWithMode("inline");
      expect(() => assertStandaloneProcess()).toThrow(/both containers indexing/i);
    });

    it("refuses to start when indexing is off", () => {
      loadWithMode("off");
      expect(() => assertStandaloneProcess()).toThrow(/INDEXER_MODE=off/);
    });
  });
});
