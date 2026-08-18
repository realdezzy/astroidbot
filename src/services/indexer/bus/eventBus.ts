import type { SwapEvent } from "../events/canonical.js";
import { logger } from "../../../utils/logger.js";

export interface SwapEventHandler {
  (event: SwapEvent): Promise<void>;
}

export class EventBus {
  private static instance: EventBus;
  private handlers: SwapEventHandler[] = [];

  static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  async publishSwap(event: SwapEvent): Promise<void> {
    logger.debug("[eventbus] swap event published", {
      chainId: event.chainId,
      txKey: event.txKey,
    });

    for (const handler of this.handlers) {
      try {
        await handler(event);
      } catch (err) {
        logger.error("[eventbus] handler error", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  subscribeSwaps(handler: SwapEventHandler): void {
    this.handlers.push(handler);
  }

  clear(): void {
    this.handlers = [];
  }
}
