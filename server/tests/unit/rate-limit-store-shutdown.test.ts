/**
 * RC-05 (scripts/vitest-leak-inventory.json): every CachedPostgresStore arms a
 * 15 s flush interval when express-rate-limit calls its `init()`. About 38 of
 * them are built when the rate-limited route modules load, so each fresh
 * module graph (unit-fresh resets the graph before every file) leaves 38 more
 * live intervals behind, and each one keeps its whole graph reachable.
 *
 * Contract pinned here:
 *   - CachedPostgresStore implements express-rate-limit's optional
 *     `Store.shutdown()` (as MemoryStore does): it clears the interval that
 *     `init()` armed, and a second call is a no-op.
 *   - src/middleware/rate-limit-store-registry.ts keeps every armed store in
 *     process-wide state (one globalThis key), so its `shutdownAll()` reaches
 *     the stores of every module graph, including graphs evaluated from a
 *     different instance of the registry module. tests/setup/fresh-module-graph.ts
 *     calls it before each `vi.resetModules()`.
 *
 * The interval is unref'd, so `process.getActiveResourcesInfo()` does not list
 * it; the stores arm it on vitest's fake clock here and the test counts it with
 * `vi.getTimerCount()`. Stores are armed through express-rate-limit's
 * `rateLimit()`, which is how production calls `init()`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { rateLimit } from 'express-rate-limit';
import { CachedPostgresStore } from '../../src/middleware/pg-rate-limit-store.js';

const REGISTRY = '../../src/middleware/rate-limit-store-registry.js';
const NEXT_GRAPH_STORE = '../../src/middleware/pg-rate-limit-store.js?graph=next';
const SYNC_INTERVAL_MS = 15_000;

type Registry = { shutdownAll(): void | Promise<void> };
type ShutdownStore = CachedPostgresStore & { shutdown?: () => void | Promise<void> };

let prefixCounter = 0;

/** A store armed the way production arms it: passed to rateLimit(), which calls init(). */
function armedStore(): ShutdownStore {
  const store = buildStore();
  rateLimit({ store, windowMs: 60_000, limit: 10, validate: false });
  return store;
}

function buildStore(): ShutdownStore {
  prefixCounter += 1;
  return new CachedPostgresStore(`rc05-shutdown-${prefixCounter}:`, SYNC_INTERVAL_MS) as ShutdownStore;
}

async function loadRegistry(specifier = REGISTRY): Promise<Registry> {
  const loaded = import(/* @vite-ignore */ specifier);
  await expect(loaded, `${specifier} must exist and export shutdownAll()`).resolves.toMatchObject({
    shutdownAll: expect.any(Function),
  });
  return (await loaded) as Registry;
}

beforeAll(() => {
  // The once-per-process expired-row cleanup interval is armed by the first
  // store constructed in this worker. Arm it on the real clock so the fake
  // clock below holds only what each test arms.
  buildStore();
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CachedPostgresStore.shutdown()', () => {
  it('clears the flush interval that init() armed, and a second call is a no-op', async () => {
    const store = buildStore();
    const before = vi.getTimerCount();
    rateLimit({ store, windowMs: 60_000, limit: 10, validate: false });
    expect(vi.getTimerCount(), 'init() arms one flush interval').toBe(before + 1);

    expect(typeof store.shutdown, 'CachedPostgresStore implements Store.shutdown()').toBe('function');
    await store.shutdown!();
    expect(vi.getTimerCount(), 'shutdown() clears the flush interval').toBe(before);

    await store.shutdown!();
    vi.advanceTimersByTime(SYNC_INTERVAL_MS * 4);
    expect(vi.getTimerCount(), 'a second shutdown() changes nothing and nothing re-arms').toBe(before);
  });

  it('is a no-op on a store that was never initialised', async () => {
    const store = buildStore();
    const before = vi.getTimerCount();
    expect(typeof store.shutdown, 'CachedPostgresStore implements Store.shutdown()').toBe('function');
    await store.shutdown!();
    expect(vi.getTimerCount()).toBe(before);
  });

  it('clears only its own interval', async () => {
    const before = vi.getTimerCount();
    const first = armedStore();
    const second = armedStore();
    expect(vi.getTimerCount()).toBe(before + 2);
    expect(typeof first.shutdown, 'CachedPostgresStore implements Store.shutdown()').toBe('function');
    await first.shutdown!();
    expect(vi.getTimerCount(), 'the other store keeps flushing').toBe(before + 1);
    await second.shutdown!();
    expect(vi.getTimerCount()).toBe(before);
  });
});

describe('rate-limit store registry shutdownAll()', () => {
  it('shuts down every store armed through rateLimit(), then forgets them', async () => {
    const registry = await loadRegistry();
    await registry.shutdownAll();
    const before = vi.getTimerCount();

    armedStore();
    armedStore();
    armedStore();
    expect(vi.getTimerCount()).toBe(before + 3);

    await registry.shutdownAll();
    expect(vi.getTimerCount(), 'shutdownAll() clears all three flush intervals').toBe(before);

    await registry.shutdownAll();
    expect(vi.getTimerCount(), 'a second shutdownAll() changes nothing').toBe(before);

    armedStore();
    expect(vi.getTimerCount(), 'a store armed after shutdownAll() is tracked again').toBe(before + 1);
    await registry.shutdownAll();
    expect(vi.getTimerCount()).toBe(before);
  });

  it('is process-wide: another instance of the registry module reaches stores of every module graph', async () => {
    const registry = await loadRegistry();
    await registry.shutdownAll();
    const before = vi.getTimerCount();

    // A second evaluation of the store module stands in for the next file's
    // fresh module graph, and a second evaluation of the registry module for
    // the instance tests/setup/fresh-module-graph.ts reaches after a reset.
    const nextGraph = (await import(/* @vite-ignore */ NEXT_GRAPH_STORE)) as typeof import('../../src/middleware/pg-rate-limit-store.js');
    armedStore();
    const other = new nextGraph.CachedPostgresStore('rc05-shutdown-next-graph:', SYNC_INTERVAL_MS);
    rateLimit({ store: other, windowMs: 60_000, limit: 10, validate: false });
    expect(vi.getTimerCount()).toBe(before + 2);

    const otherRegistry = await loadRegistry(`${REGISTRY}?instance=other`);
    await otherRegistry.shutdownAll();
    expect(vi.getTimerCount(), 'one shutdownAll() reaches both graphs').toBe(before);
  });
});
