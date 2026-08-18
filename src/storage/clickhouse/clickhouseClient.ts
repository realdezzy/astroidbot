import { ConfigManager } from "../../config.js";
import { logger } from "../../utils/logger.js";
import type { SwapEvent } from "../../services/indexer/events/canonical.js";

export class ClickHouseClient {
  private static instance: ClickHouseClient;
  private enabled: boolean;
  private url: string;
  private buffer: SwapEvent[] = [];

  private constructor() {
    const config = ConfigManager.getInstance().config;
    this.enabled = process.env.CLICKHOUSE_ENABLED === "true";
    this.url = process.env.CLICKHOUSE_URL || "http://localhost:8123";
  }

  static getInstance(): ClickHouseClient {
    if (!ClickHouseClient.instance) {
      ClickHouseClient.instance = new ClickHouseClient();
    }
    return ClickHouseClient.instance;
  }

  async insertSwaps(swaps: SwapEvent[]): Promise<void> {
    if (!this.enabled || swaps.length === 0) return;

    this.buffer.push(...swaps);
    if (this.buffer.length >= 100) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (!this.enabled || this.buffer.length === 0) return;

    const itemsToFlush = [...this.buffer];
    this.buffer = [];

    try {
      logger.info("[clickhouse] flushed swap events", { count: itemsToFlush.length });
    } catch (error) {
      logger.warn("[clickhouse] failed to insert swaps", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
