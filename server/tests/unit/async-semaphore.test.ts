import { describe, it, expect } from 'vitest';
import { AsyncSemaphore, SemaphoreOverloadedError } from '../../src/utils/async-semaphore.js';

/** A task that only settles when the test says so. */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

describe('AsyncSemaphore', () => {
  it('runs up to the limit concurrently and defers the rest', async () => {
    const semaphore = new AsyncSemaphore(2, 10);
    const gates = [deferred(), deferred(), deferred()];
    let started = 0;

    const runs = gates.map((gate) => semaphore.run(async () => {
      started++;
      await gate.promise;
    }));

    await Promise.resolve();
    expect(started).toBe(2);

    gates[0].resolve();
    await runs[0];
    expect(started).toBe(3);

    gates[1].resolve();
    gates[2].resolve();
    await Promise.all(runs);
  });

  it('rejects once the wait list is full instead of queueing without bound', async () => {
    const semaphore = new AsyncSemaphore(1, 1);
    const active = deferred();
    const queued = deferred();

    const running = semaphore.run(async () => { await active.promise; });
    const waiting = semaphore.run(async () => { await queued.promise; });

    await expect(semaphore.run(async () => undefined)).rejects.toBeInstanceOf(SemaphoreOverloadedError);

    active.resolve();
    queued.resolve();
    await Promise.all([running, waiting]);
  });

  it('frees capacity again after a shed request', async () => {
    const semaphore = new AsyncSemaphore(1, 0);
    const active = deferred();

    const running = semaphore.run(async () => { await active.promise; });
    await expect(semaphore.run(async () => undefined)).rejects.toBeInstanceOf(SemaphoreOverloadedError);

    active.resolve();
    await running;

    await expect(semaphore.run(async () => 'ok')).resolves.toBe('ok');
  });

  it('releases the permit when a task throws', async () => {
    const semaphore = new AsyncSemaphore(1, 0);

    await expect(semaphore.run(async () => { throw new Error('task failed'); })).rejects.toThrow('task failed');
    await expect(semaphore.run(async () => 'ok')).resolves.toBe('ok');
  });
});
