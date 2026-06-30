import { Queue, Worker, type Job, type JobsOptions } from "bullmq";
import { RedisService } from "./redis.js";
import { logger } from "../utils/logger.js";
import { ConfigManager } from "../config.js";


export const QUEUES = {
  TRADE_EXECUTION: "trade-execution",
  TRADE_CONFIRMATION: "trade-confirmation",
  STRATEGY_CYCLE: "strategy-cycle",
  NOTIFICATION: "notification",
} as const;

interface TradeJob {
  walletId: number;
  userId: number;
  senderAddress: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: number;
  direction: "BUY" | "SELL";
  reason: string;
}

interface ConfirmJob {
  tradeId: number;
  txId: string;
  userId: number;
}

export interface StrategyRunJob {
  strategyId: number;
  strategyType: string;
  userId: number;
  walletId: number;
}

const DEFAULT_OPTS: JobsOptions = {
  attempts: 3,
  backoff: { type: "exponential", delay: 2000 },
  removeOnComplete: { age: 3600 },
  removeOnFail: { age: 86400 },
};

export class QueueManager {
  private static instance: QueueManager;
  private queues: Map<string, Queue> = new Map();
  private workers: Map<string, Worker> = new Map();
  private connection: { host: string; port: number; password?: string };

  private constructor() {
    const redisUrl = ConfigManager.getInstance().config.REDIS_URL || "redis://localhost:6379";
    const url = new URL(redisUrl);
    this.connection = {
      host: url.hostname,
      port: parseInt(url.port || "6379", 10),
      password: url.password || undefined,
    };
    logger.info("QueueManager initialized", { host: this.connection.host, port: this.connection.port });
  }

  static getInstance(): QueueManager {
    if (!QueueManager.instance) {
      QueueManager.instance = new QueueManager();
    }
    return QueueManager.instance;
  }

  getQueue(name: string): Queue {
    if (!this.queues.has(name)) {
      this.queues.set(name, new Queue(name, { connection: this.connection }));
    }
    return this.queues.get(name)!;
  }

  async enqueueTrade(data: TradeJob): Promise<string> {
    const job = await this.getQueue(QUEUES.TRADE_EXECUTION).add(
      "execute-trade",
      data,
      { ...DEFAULT_OPTS, priority: data.direction === "SELL" ? 1 : 2 }
    );
    logger.info("Trade enqueued", { jobId: job.id, tokenIn: data.tokenIn, tokenOut: data.tokenOut });
    return job.id!;
  }

  async enqueueConfirmation(data: ConfirmJob): Promise<string> {
    const job = await this.getQueue(QUEUES.TRADE_CONFIRMATION).add(
      "confirm-trade",
      data,
      { ...DEFAULT_OPTS, delay: 30_000, attempts: 20, backoff: { type: "fixed", delay: 30_000 } }
    );
    return job.id!;
  }

  async enqueueStrategyRun(data: StrategyRunJob): Promise<string> {
    // jobId deduplication: prevents the same strategy/wallet pair from being queued
    // more than once per cycle if the scheduler fires while a previous job is still active.
    const jobId = `strategy-${data.strategyId}-wallet-${data.walletId}`;
    const job = await this.getQueue(QUEUES.STRATEGY_CYCLE).add(
      `run-${data.strategyType}`,
      data,
      { ...DEFAULT_OPTS, jobId }
    );
    return job.id!;
  }

  registerWorker(name: string, handler: (job: Job) => Promise<void>, concurrency = 3): void {
    if (this.workers.has(name)) return;

    const worker = new Worker(name, handler, {
      connection: this.connection,
      concurrency,
      autorun: true,
    });

    worker.on("completed", (job) => {
      logger.debug(`Job completed: ${name}`, { jobId: job?.id });
    });

    worker.on("failed", async (job, err) => {
      const attemptsMade = job?.attemptsMade ?? 0;
      const maxAttempts = job?.opts?.attempts ?? 3;
      logger.error(`Job failed: ${name}`, { jobId: job?.id, error: err.message, attempt: attemptsMade });

      if (job && attemptsMade >= maxAttempts) {
        try {
          const dlq = this.getQueue("dead-letter-queue");
          await dlq.add("dead-letter-job", {
            queueName: name,
            jobId: job.id,
            name: job.name,
            data: job.data,
            failedReason: job.failedReason || err.message,
            timestamp: Date.now(),
          });
          logger.warn(`Job ${job.id} moved to Dead Letter Queue (DLQ)`, { jobId: job.id, queue: name });
        } catch (dlqErr) {
          logger.error("Failed to route job to DLQ", { error: (dlqErr as Error).message });
        }
      }
    });

    worker.on("error", (err) => {
      logger.error(`Worker error: ${name}`, { error: err.message });
    });

    this.workers.set(name, worker);
    logger.info(`Worker registered: ${name} (concurrency: ${concurrency})`);
  }

  async getQueueStats(): Promise<Array<{ name: string; waiting: number; active: number; completed: number; failed: number; delayed: number }>> {
    const stats: Array<{ name: string; waiting: number; active: number; completed: number; failed: number; delayed: number }> = [];

    for (const name of Object.values(QUEUES)) {
      try {
        const queue = this.getQueue(name);
        const [waiting, active, completed, failed, delayed] = await Promise.all([
          queue.getWaitingCount(),
          queue.getActiveCount(),
          queue.getCompletedCount(),
          queue.getFailedCount(),
          queue.getDelayedCount(),
        ]);
        stats.push({ name, waiting, active, completed, failed, delayed });
      } catch {
        stats.push({ name, waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0 });
      }
    }

    return stats;
  }

  async shutdown(): Promise<void> {
    for (const [name, worker] of this.workers) {
      await worker.close();
      logger.info(`Worker closed: ${name}`);
    }
    for (const [, queue] of this.queues) {
      await queue.close();
    }
    this.workers.clear();
    this.queues.clear();
    logger.info("QueueManager shut down");
  }
}
