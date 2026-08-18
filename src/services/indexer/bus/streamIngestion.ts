import { EventBus } from "./eventBus.js";
import { logger } from "../../../utils/logger.js";
import type { ChainId } from "../../../types/chain.js";

export class StreamIngestionService {
  private static instance: StreamIngestionService;
  private activeStreams = new Set<string>();

  static getInstance(): StreamIngestionService {
    if (!StreamIngestionService.instance) {
      StreamIngestionService.instance = new StreamIngestionService();
    }
    return StreamIngestionService.instance;
  }

  startStream(chainId: ChainId, providerUrl: string): void {
    if (this.activeStreams.has(chainId)) return;

    this.activeStreams.add(chainId);
    logger.info("[stream-ingestion] starting real-time event stream", {
      chainId,
      providerUrl,
    });
  }

  stopStream(chainId: ChainId): void {
    if (this.activeStreams.delete(chainId)) {
      logger.info("[stream-ingestion] stopped real-time stream", { chainId });
    }
  }

  isStreaming(chainId: ChainId): boolean {
    return this.activeStreams.has(chainId);
  }
}
