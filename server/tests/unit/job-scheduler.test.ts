import { afterEach, describe, expect, it, vi } from 'vitest';

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));
const notifySystemErrorMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/logger.js', () => ({
  logger: { child: () => loggerMock },
}));
vi.mock('../../src/addie/error-notifier.js', () => ({
  notifySystemError: notifySystemErrorMock,
}));

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
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it('does not page before a job reaches its consecutive failure threshold', async () => {
    vi.useFakeTimers();

    const scheduler = new JobScheduler();
    scheduler.register({
      name: 'flaky-job',
      description: 'Run flaky job',
      interval: { value: 1, unit: 'hours' },
      initialDelay: { value: 1, unit: 'seconds' },
      failureThreshold: 2,
      runner: async () => {
        throw new Error('transient failure');
      },
    });

    scheduler.start('flaky-job');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: 'flaky-job',
        consecutiveFailures: 1,
        threshold: 2,
      }),
      'Run flaky job: failed',
    );
    expect(loggerMock.error).not.toHaveBeenCalled();
    expect(notifySystemErrorMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60 * 60 * 1_000 - 1_000);

    expect(notifySystemErrorMock).toHaveBeenCalledWith({
      source: 'job:flaky-job',
      errorMessage: '[2 consecutive failures] transient failure',
    });
    scheduler.stopAll();
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
    expect(loggerMock.warn).toHaveBeenCalledWith(
      { jobName: 'slow-heartbeat' },
      'Skipping - previous run still executing',
    );

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

  it('records and logs the memory delta for each completed job', async () => {
    vi.useFakeTimers();
    const memorySpy = vi.spyOn(process, 'memoryUsage')
      .mockReturnValueOnce({
        rss: 100 * 1024 * 1024,
        heapTotal: 60 * 1024 * 1024,
        heapUsed: 40 * 1024 * 1024,
        external: 5 * 1024 * 1024,
        arrayBuffers: 0,
      })
      .mockReturnValueOnce({
        rss: 112 * 1024 * 1024,
        heapTotal: 66 * 1024 * 1024,
        heapUsed: 47 * 1024 * 1024,
        external: 7 * 1024 * 1024,
        arrayBuffers: 0,
      });

    const scheduler = new JobScheduler();
    scheduler.register({
      name: 'profiled-job',
      description: 'Profiled job',
      interval: { value: 1, unit: 'hours' },
      initialDelay: { value: 1, unit: 'seconds' },
      runner: async () => undefined,
    });

    scheduler.start('profiled-job');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(scheduler.getStatus()[0].lastMemoryProfile).toEqual({
      before: { rssMb: 100, heapUsedMb: 40, heapTotalMb: 60, externalMb: 5 },
      after: { rssMb: 112, heapUsedMb: 47, heapTotalMb: 66, externalMb: 7 },
      delta: { rssMb: 12, heapUsedMb: 7, heapTotalMb: 6, externalMb: 2 },
    });
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        jobName: 'profiled-job',
        memory: expect.objectContaining({
          delta: expect.objectContaining({ rssMb: 12, heapUsedMb: 7 }),
        }),
      }),
      'Scheduled job memory profile',
    );

    memorySpy.mockRestore();
    scheduler.stopAll();
  });
});
