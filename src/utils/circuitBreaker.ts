import { logger } from "./logger.js";

export enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  cooldownMs?: number;
  requiredSuccessesInHalfOpen?: number;
}

export class CircuitBreaker {
  public readonly name: string;
  private state: CircuitState = CircuitState.CLOSED;
  private failureThreshold: number;
  private cooldownMs: number;
  private failuresCount: number = 0;
  private lastFailureTime?: number;
  private successesInHalfOpen: number = 0;
  private requiredSuccessesInHalfOpen: number;

  constructor(name: string, opts?: CircuitBreakerOptions) {
    this.name = name;
    this.failureThreshold = opts?.failureThreshold ?? 5;
    this.cooldownMs = opts?.cooldownMs ?? 60000;
    this.requiredSuccessesInHalfOpen = opts?.requiredSuccessesInHalfOpen ?? 2;
  }

  public getState(): CircuitState {
    this.checkCooldown();
    return this.state;
  }

  private checkCooldown(): void {
    if (this.state === CircuitState.OPEN && this.lastFailureTime) {
      if (Date.now() - this.lastFailureTime > this.cooldownMs) {
        this.state = CircuitState.HALF_OPEN;
        this.successesInHalfOpen = 0;
        logger.info(`Circuit breaker for ${this.name} entered HALF_OPEN state`);
      }
    }
  }

  public async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.checkCooldown();

    if (this.state === CircuitState.OPEN) {
      throw new Error(`Circuit breaker for ${this.name} is OPEN`);
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error as Error);
      throw error;
    }
  }

  private onSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.successesInHalfOpen++;
      if (this.successesInHalfOpen >= this.requiredSuccessesInHalfOpen) {
        this.state = CircuitState.CLOSED;
        this.failuresCount = 0;
        this.lastFailureTime = undefined;
        logger.info(`Circuit breaker for ${this.name} returned to CLOSED state`);
      }
    } else if (this.state === CircuitState.CLOSED) {
      this.failuresCount = 0;
    }
  }

  private onFailure(error: Error): void {
    this.failuresCount++;
    this.lastFailureTime = Date.now();

    if (this.state === CircuitState.CLOSED) {
      if (this.failuresCount >= this.failureThreshold) {
        this.state = CircuitState.OPEN;
        logger.warn(`Circuit breaker for ${this.name} tripped to OPEN state`, {
          failures: this.failuresCount,
          lastError: error.message,
        });
      }
    } else if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.OPEN;
      logger.warn(`Circuit breaker for ${this.name} failed in HALF_OPEN and returned to OPEN state`, {
        lastError: error.message,
      });
    }
  }
}

export class CircuitBreakerRegistry {
  private static breakers: Map<string, CircuitBreaker> = new Map();

  public static getBreaker(name: string, opts?: CircuitBreakerOptions): CircuitBreaker {
    let breaker = this.breakers.get(name);
    if (!breaker) {
      breaker = new CircuitBreaker(name, opts);
      this.breakers.set(name, breaker);
    }
    return breaker;
  }

  public static clear(): void {
    this.breakers.clear();
  }
}
