/**
 * Process-wide registry of rate-limit stores that run a timer.
 *
 * A store registers itself when express-rate-limit arms it (`init()`) and
 * leaves when it shuts down. `shutdownAll()` stops every registered store.
 *
 * The registry lives on `globalThis` rather than in module scope, so it holds
 * the stores of every evaluation of the store module in this process. Under
 * vitest, a file that resets the module registry gets a fresh module graph,
 * and the rate-limited route modules it loads build and arm a new set of
 * stores; `tests/setup/fresh-module-graph.ts` stops the previous graph's
 * stores before each reset. Production evaluates each module once and does
 * not call `shutdownAll()`.
 *
 * This module imports nothing, so any graph can load it cheaply.
 */

/** A store with express-rate-limit's optional `Store.shutdown()`. */
export interface ShutdownableStore {
  shutdown(): void | Promise<void>;
}

const REGISTRY_KEY = '__adcp_rate_limit_stores__';

function registeredStores(): Set<ShutdownableStore> {
  const g = globalThis as typeof globalThis & { [REGISTRY_KEY]?: Set<ShutdownableStore> };
  g[REGISTRY_KEY] ??= new Set();
  return g[REGISTRY_KEY];
}

/** Track a store whose timer is armed. */
export function registerRateLimitStore(store: ShutdownableStore): void {
  registeredStores().add(store);
}

/** Stop tracking a store; its `shutdown()` calls this. */
export function unregisterRateLimitStore(store: ShutdownableStore): void {
  registeredStores().delete(store);
}

/** Shut down every registered store, in every module graph of this process. */
export async function shutdownAll(): Promise<void> {
  const stores = [...registeredStores()];
  registeredStores().clear();
  for (const store of stores) {
    await store.shutdown();
  }
}
