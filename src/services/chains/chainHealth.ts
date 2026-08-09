import { ChainAdapterRegistry } from "./chainAdapterRegistry.js";
import { CircuitBreakerRegistry, CircuitState } from "../../utils/circuitBreaker.js";
import { NotificationService } from "../notificationService.js";
import { DatabaseService } from "../db.js";
import { logger } from "../../utils/logger.js";
import type { ChainId } from "../../types/chain.js";

/**
 * Per-chain RPC health.
 *
 * Circuit breakers already isolated a failing chain so it couldn't degrade the
 * others. What was missing was anyone finding out: a chain whose RPC had been
 * failing for a day was visible only to someone reading logs, and the symptom
 * users saw — "no route" on every pair — is indistinguishable from a chain
 * with no liquidity.
 *
 * Two surfaces, one source:
 *
 *  - `GET /api/health/chains`, so a probe or dashboard can see per-chain state
 *    without parsing logs.
 *  - An admin alert through NotificationService the moment a chain crosses
 *    from healthy to unhealthy, and again when it recovers.
 *
 * Counters are in-memory and per-process. That is the right scope: they
 * describe *this* process's ability to reach a chain, which is exactly the
 * question when one container's egress is broken and another's isn't.
 */

/** Consecutive failures before a chain is called unhealthy. */
const UNHEALTHY_AFTER = 3;

/**
 * Silence between repeat alerts for one chain. An RPC outage lasts hours and
 * every ingestion tick touches it; without this the first hour of an outage
 * would be several hundred identical Telegram messages, which is how people
 * learn to mute the alert channel.
 */
const ALERT_COOLDOWN_MS = 30 * 60 * 1000;

export interface ChainHealthSnapshot {
  chainId: string;
  displayName: string;
  healthy: boolean;
  /** CLOSED / OPEN / HALF_OPEN, or null when the chain has no breaker yet. */
  breaker: string | null;
  consecutiveFailures: number;
  successes: number;
  failures: number;
  lastOkAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
}

interface ChainCounters {
  successes: number;
  failures: number;
  consecutiveFailures: number;
  lastOkAt: Date | null;
  lastFailureAt: Date | null;
  lastError: string | null;
  alerted: boolean;
  /**
   * Cooldown clock per alert kind, not one shared clock.
   *
   * Sharing it meant the recovery notice was swallowed by the cooldown the
   * outage notice had just started — so an incident opened loudly and closed
   * silently, and the only way to learn a chain was back was to go and look.
   * That is precisely what this monitor exists to avoid.
   */
  lastAlertAt: { WARNING: number; SUCCESS: number };
}

function emptyCounters(): ChainCounters {
  return {
    successes: 0,
    failures: 0,
    consecutiveFailures: 0,
    lastOkAt: null,
    lastFailureAt: null,
    lastError: null,
    alerted: false,
    lastAlertAt: { WARNING: 0, SUCCESS: 0 },
  };
}

export class ChainHealthMonitor {
  private static instance: ChainHealthMonitor;
  private counters = new Map<string, ChainCounters>();

  static getInstance(): ChainHealthMonitor {
    if (!ChainHealthMonitor.instance) ChainHealthMonitor.instance = new ChainHealthMonitor();
    return ChainHealthMonitor.instance;
  }

  private countersFor(chainId: string): ChainCounters {
    let c = this.counters.get(chainId);
    if (!c) {
      c = emptyCounters();
      this.counters.set(chainId, c);
    }
    return c;
  }

  recordSuccess(chainId: ChainId | string): void {
    const c = this.countersFor(chainId);
    c.successes++;
    c.consecutiveFailures = 0;
    c.lastOkAt = new Date();

    if (c.alerted) {
      c.alerted = false;
      void this.alert(
        chainId,
        `${chainId} RPC recovered`,
        `Reachable again after ${c.failures} failure(s).`,
        "SUCCESS"
      );
    }
  }

  recordFailure(chainId: ChainId | string, error: unknown): void {
    const c = this.countersFor(chainId);
    c.failures++;
    c.consecutiveFailures++;
    c.lastFailureAt = new Date();
    c.lastError = error instanceof Error ? error.message : String(error);

    if (c.consecutiveFailures >= UNHEALTHY_AFTER && !c.alerted) {
      c.alerted = true;
      void this.alert(
        chainId,
        `${chainId} RPC failing`,
        `${c.consecutiveFailures} consecutive failures. Last error: ${c.lastError}`
      );
    }
  }

  /** Wraps a chain-bound call so success and failure are both counted. */
  async track<T>(chainId: ChainId | string, fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      this.recordSuccess(chainId);
      return result;
    } catch (error) {
      this.recordFailure(chainId, error);
      throw error;
    }
  }

  healthy(chainId: string): boolean {
    return this.countersFor(chainId).consecutiveFailures < UNHEALTHY_AFTER;
  }

  /**
   * One row per registered chain, whether or not it has been exercised yet.
   *
   * Reporting only chains that have been called would make a chain that is
   * failing at *registration* invisible, which is the case most worth seeing.
   */
  snapshot(): ChainHealthSnapshot[] {
    return ChainAdapterRegistry.getInstance()
      .list()
      .map((descriptor) => {
        const c = this.countersFor(descriptor.chainId);
        return {
          chainId: descriptor.chainId,
          displayName: descriptor.displayName,
          healthy: c.consecutiveFailures < UNHEALTHY_AFTER,
          breaker: this.breakerState(descriptor.chainId),
          consecutiveFailures: c.consecutiveFailures,
          successes: c.successes,
          failures: c.failures,
          lastOkAt: c.lastOkAt?.toISOString() ?? null,
          lastFailureAt: c.lastFailureAt?.toISOString() ?? null,
          lastError: c.lastError,
        };
      });
  }

  /**
   * The DEX provider's breaker for this chain, if one has been created.
   *
   * Read rather than registered: providers name their breakers after
   * themselves, and duplicating that naming here would create a second source
   * of truth that could disagree with the one doing the actual tripping.
   */
  private breakerState(chainId: string): string | null {
    const breaker = CircuitBreakerRegistry.find(`UniswapV3-${chainId}`);
    return breaker ? breaker.getState() : null;
  }

  /** True when any registered chain is currently unhealthy. */
  anyUnhealthy(): boolean {
    return this.snapshot().some((s) => !s.healthy || s.breaker === CircuitState.OPEN);
  }

  /**
   * Notifies admins. Best-effort by construction: an alerting path that can
   * throw would take down the operation it was reporting on.
   */
  private async alert(
    chainId: string,
    title: string,
    message: string,
    type: "WARNING" | "SUCCESS" = "WARNING"
  ): Promise<void> {
    const c = this.countersFor(chainId);
    // Per-kind, so a chain flapping down/up/down is still rate-limited but a
    // recovery is never blocked by the outage that preceded it.
    if (Date.now() - c.lastAlertAt[type] < ALERT_COOLDOWN_MS) return;
    c.lastAlertAt[type] = Date.now();

    logger.warn(`[chainHealth] ${title}`, { chainId, message });

    try {
      const admins = await DatabaseService.getInstance().prisma.user.findMany({
        where: { isAdmin: true },
        select: { id: true },
      });

      await Promise.all(
        admins.map((admin) =>
          NotificationService.getInstance().send({ userId: admin.id, title, message, type })
        )
      );
    } catch (error) {
      logger.warn("[chainHealth] failed to deliver alert", {
        chainId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  reset(): void {
    this.counters.clear();
  }
}
