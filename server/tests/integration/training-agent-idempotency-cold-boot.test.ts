import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { closeDatabase, initializeDatabase, isDatabaseInitialized } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import {
  clearIdempotencyCache,
  getIdempotencyStore,
  getSdkIdempotencyStore,
  type OwnedIdempotencyStore,
} from '../../src/training-agent/idempotency.js';

describe.skipIf(!process.env.DATABASE_URL)('training-agent idempotency across cold boot and stores', () => {
  const principal = `cold-boot-${randomUUID()}`;
  const keys: string[] = [];
  let pool: Pool | undefined;
  let earlyStore: OwnedIdempotencyStore;
  let secondStore: OwnedIdempotencyStore;
  let earlyReadiness: PromiseSettledResult<unknown>;
  let earlyMutation: PromiseSettledResult<unknown>;

  const request = (suffix: string, budget = 5_000) => {
    const key = `cold-boot-${suffix}-${randomUUID()}`;
    keys.push(`${principal}\u001F${key}`);
    return { principal, key, payload: { budget } };
  };

  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'production');
    await clearIdempotencyCache();
    expect(isDatabaseInitialized()).toBe(false);

    // Tenant prewarming resolves the SDK adapter before database startup.
    // Construction must succeed, but readiness and mutations must fail closed.
    const sdkStore = getSdkIdempotencyStore();
    earlyStore = getIdempotencyStore();
    // Record both outcomes without aborting setup: the original memory backend
    // must still reach the real-PG cross-store regressions below.
    [earlyReadiness, earlyMutation] = await Promise.allSettled([
      Promise.resolve().then(() => sdkStore.probe!()),
      Promise.resolve().then(() => sdkStore.check(request('before-pool'))),
    ]);

    pool = initializeDatabase({ connectionString: process.env.DATABASE_URL });
    await runMigrations();
    await earlyStore.probe!();

    // Retain the earlier adapter while constructing another independent store.
    // PostgreSQL backends do not own or close the caller's database pool.
    await clearIdempotencyCache();
    secondStore = getIdempotencyStore();
    await secondStore.probe!();
  }, 180_000);

  afterAll(async () => {
    try {
      if (pool) {
        await pool.query('DELETE FROM adcp_idempotency WHERE scoped_key = ANY($1::text[])', [keys]);
      }
    } finally {
      await clearIdempotencyCache();
      await closeDatabase();
      vi.unstubAllEnvs();
    }
  });

  it('rejects readiness before PostgreSQL is initialized', () => {
    expect(earlyReadiness.status).toBe('rejected');
    if (earlyReadiness.status === 'rejected') {
      expect(earlyReadiness.reason).toBeInstanceOf(Error);
      expect(earlyReadiness.reason.message).toMatch(/idempotency backend probe failed/);
    }
  });

  it('rejects mutations before PostgreSQL is initialized', () => {
    expect(earlyMutation.status).toBe('rejected');
    if (earlyMutation.status === 'rejected') {
      expect(earlyMutation.reason).toBeInstanceOf(Error);
      expect(earlyMutation.reason.message).toMatch(/database operation failed/);
    }
  });

  it('persists an adapter created before initialization and replays from another store', async () => {
    const input = request('replay');
    const claim = await earlyStore.check(input);
    if (claim.kind !== 'miss') throw new Error('Expected the first request to claim the key');
    expect(await secondStore.check(input)).toMatchObject({ kind: 'in-flight' });
    expect(await secondStore.check({ ...input, payload: { budget: 25_000 } })).toEqual({ kind: 'conflict' });

    await earlyStore.renew({ ...input, claimToken: claim.claimToken });
    const response = { media_buy_id: 'cold-boot-buy' };
    await earlyStore.save({ ...input, payloadHash: claim.payloadHash, claimToken: claim.claimToken, response });
    expect(await secondStore.check(input)).toEqual({ kind: 'replay', response });
    const rows = await pool!.query('SELECT response FROM adcp_idempotency WHERE scoped_key = $1', [
      `${input.principal}\u001F${input.key}`,
    ]);
    expect(rows.rows).toEqual([{ response }]);
  });

  it('grants exactly one concurrent claim across independent PostgreSQL stores', async () => {
    const input = request('concurrent');
    const stores = [earlyStore, secondStore];
    const results = await Promise.all(stores.map(store => store.check(input)));
    expect(results.map(result => result.kind).sort()).toEqual(['in-flight', 'miss']);
    const winnerIndex = results.findIndex(result => result.kind === 'miss');
    const claim = results[winnerIndex]!;
    if (claim.kind !== 'miss') throw new Error('Expected exactly one claim owner');
    const response = { media_buy_id: 'concurrent-buy' };
    await stores[winnerIndex]!.save({ ...input, payloadHash: claim.payloadHash, claimToken: claim.claimToken, response });
    expect(await stores[1 - winnerIndex]!.check(input)).toEqual({ kind: 'replay', response });
  });

  it('keeps owner fencing when another store takes over a released claim', async () => {
    const input = request('released');
    const original = await earlyStore.check(input);
    if (original.kind !== 'miss') throw new Error('Expected the initial claim');
    await earlyStore.release({ ...input, claimToken: original.claimToken });
    const replacement = await secondStore.check(input);
    if (replacement.kind !== 'miss') throw new Error('Expected a fresh owner after release');

    await expect(earlyStore.renew({ ...input, claimToken: original.claimToken })).rejects.toThrow(/ownership was lost/);
    await expect(earlyStore.save({
      ...input, payloadHash: original.payloadHash, claimToken: original.claimToken,
      response: { media_buy_id: 'stale-owner' },
    })).rejects.toThrow(/ownership was lost/);
    const response = { media_buy_id: 'replacement-owner' };
    await secondStore.save({ ...input, payloadHash: replacement.payloadHash, claimToken: replacement.claimToken, response });
    expect(await earlyStore.check(input)).toEqual({ kind: 'replay', response });
  });

  it('retains PostgreSQL replay when development has an initialized pool', async () => {
    const input = request('development');
    const claim = await earlyStore.check(input);
    if (claim.kind !== 'miss') throw new Error('Expected the initial claim');
    const response = { media_buy_id: 'development-replay' };
    await earlyStore.save({ ...input, payloadHash: claim.payloadHash, claimToken: claim.claimToken, response });
    vi.stubEnv('NODE_ENV', 'development');
    await clearIdempotencyCache();
    expect(await getIdempotencyStore().check(input)).toEqual({ kind: 'replay', response });
  });
});
