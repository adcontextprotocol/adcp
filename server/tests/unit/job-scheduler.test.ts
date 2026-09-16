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

  it('does not overlap interval runs of the same slow job', async () => {
    vi.useFakeTimers();

    const scheduler = new JobScheduler();
    const blocker = deferred();
    const runner = vi.fn(async () => blocker.promise);
    scheduler.register({
      name: 'slow-heartbeat',
      description: 'Slow heartbeat',
      interval: { value: 1, unit: 'seconds' },
      runner,
    });

    scheduler.start('slow-heartbeat');
    await vi.advanceTimersByTimeAsync(0);
    expect(runner).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(3_000);
    expect(runner).toHaveBeenCalledOnce();

    blocker.resolve();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runner).toHaveBeenCalledTimes(2);
    scheduler.stopAll();
  });

  it('aborts timed-out jobs and releases their concurrency slots', async () => {
    vi.useFakeTimers();

    const scheduler = new JobScheduler();
    let observedSignal: AbortSignal | undefined;
    scheduler.register({
      name: 'wedged-job',
      description: 'Wedged job',
      interval: { value: 1, unit: 'hours' },
      initialDelay: { value: 1, unit: 'seconds' },
      executionTimeoutMs: 5_000,
      passExecutionContext: true,
      runner: async (_options, context) => {
        observedSignal = context.signal;
        await new Promise<void>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    });

    scheduler.start('wedged-job');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(scheduler.getPoolStatus()).toEqual({
      activeJobs: 1,
      queuedJobs: 0,
      maxConcurrency: 5,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(observedSignal?.aborted).toBe(true);
    expect(scheduler.getPoolStatus()).toEqual({
      activeJobs: 0,
      queuedJobs: 0,
      maxConcurrency: 5,
    });
    expect(scheduler.getStatus()[0]).toMatchObject({
      executing: false,
      executionTimeoutMs: 5_000,
      lastError: 'Wedged job timed out after 5000ms',
      consecutiveFailures: 1,
    });
    scheduler.stopAll();
  });

  it('reports jobs waiting for the shared concurrency pool', async () => {
    vi.useFakeTimers();

    const scheduler = new JobScheduler();
    const blockers: ReturnType<typeof deferred>[] = [];
    for (let i = 0; i < 6; i++) {
      const blocker = deferred();
      blockers.push(blocker);
      scheduler.register({
        name: `pool-job-${i}`,
        description: `Pool job ${i}`,
        interval: { value: 1, unit: 'hours' },
        initialDelay: { value: 1, unit: 'seconds' },
        runner: async () => blocker.promise,
      });
    }

    scheduler.startAll();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(scheduler.getPoolStatus()).toEqual({
      activeJobs: 5,
      queuedJobs: 1,
      maxConcurrency: 5,
    });

    for (const blocker of blockers) blocker.resolve();
    await flushMicrotasks(10);
    expect(scheduler.getPoolStatus()).toEqual({
      activeJobs: 0,
      queuedJobs: 0,
      maxConcurrency: 5,
    });
    scheduler.stopAll();
  });

  it('does not pass scheduler context into legacy dependency-injection arguments', async () => {
    vi.useFakeTimers();

    const scheduler = new JobScheduler();
    let observedDependencies: { testDependency?: boolean } | undefined;
    scheduler.register({
      name: 'legacy-runner',
      description: 'Legacy runner',
      interval: { value: 1, unit: 'hours' },
      initialDelay: { value: 1, unit: 'seconds' },
      runner: async (_options, dependencies?: { testDependency?: boolean }) => {
        observedDependencies = dependencies;
      },
    });

    scheduler.start('legacy-runner');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(observedDependencies).toBeUndefined();
    scheduler.stopAll();
  });
});
