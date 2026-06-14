import { afterEach, describe, expect, it, vi } from 'vitest';
import { JobScheduler } from '../../src/addie/jobs/scheduler.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function flushMicrotasks(times = 5) {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('JobScheduler', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('releases transferred concurrency slots after queued jobs finish', async () => {
    vi.useFakeTimers();

    const scheduler = new JobScheduler();
    const started: string[] = [];
    const blockers = new Map<string, ReturnType<typeof deferred>>();

    for (let i = 0; i < 10; i++) {
      const name = `job-${i}`;
      const blocker = deferred();
      blockers.set(name, blocker);
      scheduler.register({
        name,
        description: name,
        interval: { value: 1, unit: 'hours' },
        initialDelay: { value: 1, unit: 'seconds' },
        runner: async () => {
          started.push(name);
          await blocker.promise;
        },
      });
    }

    scheduler.startAll();
    await vi.advanceTimersByTimeAsync(1000);

    expect(started).toEqual(['job-0', 'job-1', 'job-2', 'job-3', 'job-4']);

    for (let i = 0; i < 5; i++) {
      blockers.get(`job-${i}`)?.resolve();
    }
    await flushMicrotasks();

    expect(started).toEqual([
      'job-0',
      'job-1',
      'job-2',
      'job-3',
      'job-4',
      'job-5',
      'job-6',
      'job-7',
      'job-8',
      'job-9',
    ]);

    for (let i = 5; i < 10; i++) {
      blockers.get(`job-${i}`)?.resolve();
    }
    await flushMicrotasks();

    scheduler.register({
      name: 'after-queue',
      description: 'after queue',
      interval: { value: 1, unit: 'hours' },
      initialDelay: { value: 1, unit: 'seconds' },
      runner: async () => {
        started.push('after-queue');
      },
    });
    scheduler.start('after-queue');
    await vi.advanceTimersByTimeAsync(1000);
    await flushMicrotasks();

    expect(started).toContain('after-queue');
    scheduler.stopAll();
  });
});
