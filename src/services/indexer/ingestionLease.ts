import { AsyncLocalStorage } from "node:async_hooks";

const leases = new AsyncLocalStorage<() => Promise<void>>();

export function withIngestionLease<T>(check: () => Promise<void>, work: () => Promise<T>): Promise<T> {
  return leases.run(check, work);
}

/** A lost lease must stop writes as well as background renewal. */
export async function assertIngestionLease(): Promise<void> {
  await leases.getStore()?.();
}
