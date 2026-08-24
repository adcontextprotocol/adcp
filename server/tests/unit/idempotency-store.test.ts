import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hashPayload,
  memoryBackend,
  type IdempotencyBackend,
} from '@adcp/sdk/server';
import {
  adaptOwnedIdempotencyStoreForSdk,
  createHashAwareIdempotencyStore,
} from '../../src/training-agent/idempotency.js';

const PRINCIPAL = 'store-test-principal';
const KEY = 'store-test-key-0001';
const SCOPED_KEY = `${PRINCIPAL}\u001F${KEY}`;

describe('hash-aware training-agent idempotency store', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('atomically stores the canonical hash and reports a matching concurrent claim as in-flight', async () => {
    const backend = memoryBackend({ sweepIntervalMs: 0 });
    const store = createHashAwareIdempotencyStore({ backend });
    const payload = { budget: 5_000, idempotency_key: KEY };

    const results = await Promise.all([
      store.check({ principal: PRINCIPAL, key: KEY, payload }),
      store.check({ principal: PRINCIPAL, key: KEY, payload: { ...payload } }),
    ]);

    expect(results.filter(result => result.kind === 'miss')).toHaveLength(1);
    const inFlight = results.find(result => result.kind === 'in-flight');
    expect(inFlight).toMatchObject({ kind: 'in-flight', retryAfterSeconds: 30 });
    expect(await backend.get(SCOPED_KEY)).toMatchObject({
      payloadHash: hashPayload(payload),
      response: { __adcp_pending_owner: expect.any(String) },
    });

    await store.close();
  });

  it('reports a different concurrent payload as a conflict instead of in-flight', async () => {
    const backend = memoryBackend({ sweepIntervalMs: 0 });
    const store = createHashAwareIdempotencyStore({ backend });

    const results = await Promise.all([
      store.check({ principal: PRINCIPAL, key: KEY, payload: { budget: 5_000 } }),
      store.check({ principal: PRINCIPAL, key: KEY, payload: { budget: 25_000 } }),
    ]);

    expect(results.map(result => result.kind).sort()).toEqual(['conflict', 'miss']);
    await store.close();
  });

  it('renews an owned claim without changing its request hash', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'));
    const backend = memoryBackend({ sweepIntervalMs: 0 });
    const store = createHashAwareIdempotencyStore({ backend });
    const payload = { operation: 'long-running' };

    const claim = await store.check({ principal: PRINCIPAL, key: KEY, payload });
    if (claim.kind !== 'miss') throw new Error('expected initial claim');
    await vi.advanceTimersByTimeAsync(100_000);
    await store.renew({
      principal: PRINCIPAL,
      key: KEY,
      claimToken: claim.claimToken,
    });

    expect(await backend.get(SCOPED_KEY)).toMatchObject({
      payloadHash: hashPayload(payload),
      expiresAt: Math.floor(Date.now() / 1e3) + 120,
      retainUntil: Math.floor(Date.now() / 1e3) + 180,
    });
    expect(await store.check({ principal: PRINCIPAL, key: KEY, payload })).toMatchObject({
      kind: 'in-flight',
    });
    expect(await store.check({ principal: PRINCIPAL, key: KEY, payload: { operation: 'other' } })).toEqual({
      kind: 'conflict',
    });

    await store.release({ principal: PRINCIPAL, key: KEY, claimToken: claim.claimToken });
    await store.close();
  });

  it('preserves expiry skew and the save, release, and transient-error lifecycle', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'));
    const backend = memoryBackend({ sweepIntervalMs: 0 });
    const store = createHashAwareIdempotencyStore({
      backend,
      ttlSeconds: 3_600,
      clockSkewSeconds: 60,
    });
    const payload = { operation: 'create' };

    const claim = await store.check({ principal: PRINCIPAL, key: KEY, payload });
    expect(claim.kind).toBe('miss');
    if (claim.kind !== 'miss') throw new Error('expected the first check to claim the key');

    await store.save({
      principal: PRINCIPAL,
      key: KEY,
      payloadHash: claim.payloadHash,
      response: { resource_id: 'resource-1' },
      claimToken: claim.claimToken,
    });
    await vi.advanceTimersByTimeAsync(3_660_000);
    expect(await store.check({ principal: PRINCIPAL, key: KEY, payload })).toMatchObject({
      kind: 'replay',
      response: { resource_id: 'resource-1' },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await store.check({ principal: PRINCIPAL, key: KEY, payload })).toEqual({ kind: 'expired' });

    const releaseKey = `${KEY}-release`;
    const releasable = await store.check({ principal: PRINCIPAL, key: releaseKey, payload });
    expect(releasable.kind).toBe('miss');
    if (releasable.kind !== 'miss') throw new Error('expected releasable claim');
    await store.release({ principal: PRINCIPAL, key: releaseKey, claimToken: releasable.claimToken });
    expect(await store.check({
      principal: PRINCIPAL,
      key: releaseKey,
      payload: { operation: 'changed-after-release' },
    })).toEqual({ kind: 'conflict' });
    const reclaimed = await store.check({ principal: PRINCIPAL, key: releaseKey, payload });
    expect(reclaimed.kind).toBe('miss');
    if (reclaimed.kind !== 'miss') throw new Error('expected release to make the key claimable');

    await store.saveTransientError!({
      principal: PRINCIPAL,
      key: releaseKey,
      payloadHash: reclaimed.payloadHash,
      response: { adcp_error: { code: 'VALIDATION_ERROR' } },
      claimToken: reclaimed.claimToken,
    });
    expect(await store.check({ principal: PRINCIPAL, key: releaseKey, payload })).toMatchObject({
      kind: 'replay',
      response: { adcp_error: { code: 'VALIDATION_ERROR' } },
    });
    await vi.advanceTimersByTimeAsync(71_000);
    expect(await store.check({ principal: PRINCIPAL, key: releaseKey, payload })).toEqual({ kind: 'expired' });

    await store.close();
  });

  it('preserves capability and delegates probe, clearAll, and close to the backend', async () => {
    const memory = memoryBackend({ sweepIntervalMs: 0 });
    const calls: string[] = [];
    const backend: IdempotencyBackend = {
      ...memory,
      async probe() {
        calls.push('probe');
      },
      async clearAll() {
        calls.push('clearAll');
        await memory.clearAll!();
      },
      async close() {
        calls.push('close');
        await memory.close!();
      },
    };
    const store = createHashAwareIdempotencyStore({ backend, ttlSeconds: 7_200 });

    expect(store.capability()).toEqual({ replay_ttl_seconds: 7_200 });
    await store.probe!();
    await store.clearAll!();
    await store.close();
    expect(calls).toEqual(['probe', 'clearAll', 'close']);
  });

  it('fences a stale owner after an expired claim is taken over', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'));
    const backend = memoryBackend({ sweepIntervalMs: 0 });
    const store = createHashAwareIdempotencyStore({ backend });
    const payload = { operation: 'finalize' };

    const first = await store.check({ principal: PRINCIPAL, key: KEY, payload });
    expect(first.kind).toBe('miss');
    if (first.kind !== 'miss') throw new Error('expected initial claim');

    await vi.advanceTimersByTimeAsync(181_000);
    const successor = await store.check({ principal: PRINCIPAL, key: KEY, payload });
    expect(successor.kind).toBe('miss');
    if (successor.kind !== 'miss') throw new Error('expected successor claim');

    await expect(store.save({
      principal: PRINCIPAL,
      key: KEY,
      payloadHash: first.payloadHash,
      response: { resource_id: 'stale' },
      claimToken: first.claimToken,
    })).rejects.toThrow('claim ownership was lost');
    await expect(store.release({
      principal: PRINCIPAL,
      key: KEY,
      claimToken: first.claimToken,
    })).rejects.toThrow('claim ownership was lost');

    await store.save({
      principal: PRINCIPAL,
      key: KEY,
      payloadHash: successor.payloadHash,
      response: { resource_id: 'winner' },
      claimToken: successor.claimToken,
    });
    expect(await store.check({ principal: PRINCIPAL, key: KEY, payload })).toMatchObject({
      kind: 'replay',
      response: { resource_id: 'winner' },
    });

    await store.close();
  });

  it('fences fallback release when an expired claim is taken over concurrently', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-09T12:00:00Z'));
    const memory = memoryBackend({ sweepIntervalMs: 0 });
    let pauseNextGet = false;
    let releaseRead!: () => void;
    const readStarted = new Promise<void>(resolve => { releaseRead = resolve; });
    let resumeRead!: () => void;
    const readCanFinish = new Promise<void>(resolve => { resumeRead = resolve; });
    const backend: IdempotencyBackend = {
      ...memory,
      async get(key) {
        const entry = await memory.get(key);
        if (pauseNextGet) {
          pauseNextGet = false;
          releaseRead();
          await readCanFinish;
        }
        return entry;
      },
    };
    const store = createHashAwareIdempotencyStore({ backend });
    const payload = { operation: 'fallback-race' };
    const first = await store.check({ principal: PRINCIPAL, key: KEY, payload });
    if (first.kind !== 'miss') throw new Error('expected initial claim');
    await vi.advanceTimersByTimeAsync(181_000);

    pauseNextGet = true;
    const releasing = store.release({
      principal: PRINCIPAL,
      key: KEY,
      claimToken: first.claimToken,
    });
    await readStarted;
    let takeoverFinished = false;
    const takeover = store.check({ principal: PRINCIPAL, key: KEY, payload }).then(result => {
      takeoverFinished = true;
      return result;
    });
    await Promise.resolve();
    expect(takeoverFinished).toBe(false);

    resumeRead();
    await expect(releasing).rejects.toThrow('claim ownership was lost');
    const successor = await takeover;
    expect(successor.kind).toBe('miss');
    if (successor.kind !== 'miss') throw new Error('expected successor claim');
    expect(await backend.get(SCOPED_KEY)).toMatchObject({
      response: { __adcp_pending_owner: successor.claimToken },
    });
    await store.release({ principal: PRINCIPAL, key: KEY, claimToken: successor.claimToken });
    await store.close();
  });

  it('passes the SDK beta.7 claim token through the adapter', async () => {
    const backend = memoryBackend({ sweepIntervalMs: 0 });
    const owned = createHashAwareIdempotencyStore({ backend });
    const adapter = adaptOwnedIdempotencyStoreForSdk(owned);
    const payload = { operation: 'adapter-release' };

    const first = await adapter.check({ principal: PRINCIPAL, key: KEY, payload });
    expect(first.kind).toBe('miss');
    if (first.kind !== 'miss') throw new Error('expected adapter claim');
    await adapter.release({ principal: PRINCIPAL, key: KEY, claimToken: first.claimToken });

    const reclaimed = await owned.check({ principal: PRINCIPAL, key: KEY, payload });
    expect(reclaimed.kind).toBe('miss');
    if (reclaimed.kind === 'miss') {
      await owned.release({ principal: PRINCIPAL, key: KEY, claimToken: reclaimed.claimToken });
    }
    await owned.close();
  });
});
