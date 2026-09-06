import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInMemoryTaskRegistry } from '@adcp/sdk/server';
import { logger } from '../../src/logger.js';
import { notifySystemError } from '../../src/addie/error-notifier.js';
import {
  InMemorySellerManagedControlJobStore,
  PostgresSellerManagedControlJobStore,
  SellerManagedControlJobCoordinator,
  rebindCachedSdkReplay,
  withSellerManagedIdempotencyReplay,
  withSellerManagedTaskReplay,
  type SellerManagedControlJob,
} from '../../src/training-agent/seller-managed-control-jobs.js';

vi.mock('../../src/addie/error-notifier.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/addie/error-notifier.js')>(
    '../../src/addie/error-notifier.js',
  );
  return { ...actual, notifySystemError: vi.fn() };
});

const INPUT = {
  taskId: 'smc_recovery_test',
  accountId: 'account_recovery_test',
  ownerScope: 'client:recovery-test',
  idempotencyPrincipal: 'client:recovery-test',
  idempotencyKey: 'seller-control-recovery-0001',
  hasWebhook: false,
  mediaBuyId: 'buy_recovery_test',
  expectedRevision: 4,
  authorizedActions: ['increase_budget'],
  request: { media_buy_id: 'buy_recovery_test', revision: 4 },
  executionContext: { mode: 'open' as const },
};
const TASK_SCOPE = { accountId: INPUT.accountId, ownerScope: INPUT.ownerScope };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function registerTask(taskRegistry: ReturnType<typeof createInMemoryTaskRegistry>): Promise<void> {
  await taskRegistry.create({
    tool: 'control_media_buy',
    accountId: INPUT.accountId,
    ownerScope: INPUT.ownerScope,
    overrideTaskId: INPUT.taskId,
  });
}

describe('seller-managed control durable jobs', () => {
  it('defers Postgres reconciliation until the database is initialized', async () => {
    vi.useFakeTimers();
    vi.stubEnv('NODE_ENV', 'production');
    let databaseReady = false;
    const store = new PostgresSellerManagedControlJobStore();
    const claim = vi.spyOn(store, 'claim').mockResolvedValue(null);
    const coordinator = new SellerManagedControlJobCoordinator(
      createInMemoryTaskRegistry(),
      async () => ({}),
      store,
      async () => {},
      () => databaseReady,
    );

    coordinator.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(claim).not.toHaveBeenCalled();

    databaseReady = true;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(claim).toHaveBeenCalledOnce();
    coordinator.stop();
  });

  it('does not overlap periodic reconciliation while a database claim is pending', async () => {
    vi.useFakeTimers();
    vi.stubEnv('NODE_ENV', 'production');
    let resolveFirstClaim!: (value: null) => void;
    const firstClaim = new Promise<null>(resolve => { resolveFirstClaim = resolve; });
    const store = new PostgresSellerManagedControlJobStore();
    const claim = vi.spyOn(store, 'claim')
      .mockReturnValueOnce(firstClaim)
      .mockResolvedValue(null);
    const coordinator = new SellerManagedControlJobCoordinator(
      createInMemoryTaskRegistry(),
      async () => ({}),
      store,
      async () => {},
      () => true,
    );

    coordinator.start();
    expect(claim).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(claim).toHaveBeenCalledOnce();

    resolveFirstClaim(null);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(claim).toHaveBeenCalledTimes(2);
    coordinator.stop();
  });

  it('alerts once after sustained reconciliation failures and logs recovery', async () => {
    vi.useFakeTimers();
    vi.stubEnv('NODE_ENV', 'production');
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => logger);
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const notifyMock = vi.mocked(notifySystemError);
    notifyMock.mockClear();
    const store = new PostgresSellerManagedControlJobStore();
    const claim = vi.spyOn(store, 'claim').mockRejectedValue(new Error('database unavailable'));
    const coordinator = new SellerManagedControlJobCoordinator(
      createInMemoryTaskRegistry(),
      async () => ({}),
      store,
      async () => {},
      () => true,
    );

    coordinator.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledOnce();
    expect(notifyMock).toHaveBeenCalledWith({
      source: 'seller-managed-control-jobs',
      errorMessage: 'Seller-control reconciliation failed (3 consecutive): database unavailable',
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledOnce();

    claim.mockResolvedValue(null);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(infoSpy).toHaveBeenCalledWith(
      expect.objectContaining({ priorFailures: 5 }),
      'Seller-control reconciliation recovered',
    );
    coordinator.stop();
  });

  it('replays the same orphaned task for the same caller idempotency key', async () => {
    const store = new InMemorySellerManagedControlJobStore();
    const first = await store.enqueue(INPUT);
    const replay = await store.findReplay(INPUT);
    expect(replay?.taskId).toBe(first.taskId);
    const enqueuedReplay = await store.enqueue(INPUT);
    expect(enqueuedReplay.taskId).toBe(first.taskId);
    const reconnectedReplay = await store.enqueue({
      ...INPUT,
      ownerScope: 'session:new-connection',
    });
    expect(reconnectedReplay.taskId).toBe(first.taskId);
    expect(await store.get(first.taskId)).toMatchObject({
      idempotencyKey: INPUT.idempotencyKey,
      requestFingerprint: first.requestFingerprint,
    });

    await expect(store.findReplay({
      ...INPUT,
      request: { ...INPUT.request, revision: 99 },
    })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('lets the SDK reconnect only an exactly scoped seller-control task ID', async () => {
    const base = createInMemoryTaskRegistry();
    const registry = withSellerManagedTaskReplay(base);
    await registry.create({
      tool: 'control_media_buy', accountId: INPUT.accountId,
      ownerScope: INPUT.ownerScope, overrideTaskId: INPUT.taskId,
    });
    await expect(registry.create({
      tool: 'control_media_buy', accountId: INPUT.accountId,
      ownerScope: INPUT.ownerScope, overrideTaskId: INPUT.taskId,
    })).resolves.toMatchObject({
      taskId: INPUT.taskId,
      accountId: INPUT.accountId,
      ownerScope: INPUT.ownerScope,
    });
    await registry.authorizeSellerManagedReplay({
      taskId: INPUT.taskId,
      accountId: INPUT.accountId,
      ownerScope: 'session:new-connection',
    });
    await expect(registry.create({
      tool: 'control_media_buy', accountId: INPUT.accountId,
      ownerScope: 'session:new-connection', overrideTaskId: INPUT.taskId,
    })).resolves.toMatchObject({
      taskId: INPUT.taskId,
      accountId: INPUT.accountId,
      ownerScope: 'session:new-connection',
    });
    expect(await registry.getTask(INPUT.taskId, {
      accountId: INPUT.accountId,
      ownerScope: 'session:new-connection',
    })).toMatchObject({
      ownerScope: 'session:new-connection',
    });
    await registry.updateProgress(INPUT.taskId, {
      accountId: INPUT.accountId,
      ownerScope: 'session:new-connection',
    }, { message: 'reconnected' });
    await registry.complete(INPUT.taskId, {
      accountId: INPUT.accountId,
      ownerScope: 'session:new-connection',
    }, { status: 'completed' });
    expect(await registry.getTask(INPUT.taskId, {
      accountId: INPUT.accountId,
      ownerScope: 'session:new-connection',
    })).toMatchObject({
      status: 'completed',
      result: { status: 'completed' },
    });
    expect(await registry.list?.({
      accountId: INPUT.accountId,
      ownerScope: 'session:new-connection',
    })).toMatchObject({ tasks: [expect.objectContaining({ taskId: INPUT.taskId })] });
    await expect(registry.create({
      tool: 'control_media_buy', accountId: 'other-account',
      ownerScope: INPUT.ownerScope, overrideTaskId: INPUT.taskId,
    })).rejects.toThrow('scope mismatch');
  });

  it('composes stable-principal replay with an authorized new-session task owner', async () => {
    const store = new InMemorySellerManagedControlJobStore();
    const registry = withSellerManagedTaskReplay(createInMemoryTaskRegistry());
    const coordinator = new SellerManagedControlJobCoordinator(registry, async () => ({}), store);
    const job = await coordinator.enqueue(INPUT);
    await registry.create({
      tool: 'control_media_buy', accountId: INPUT.accountId,
      ownerScope: 'session:original', overrideTaskId: INPUT.taskId,
    });

    const replayInput = { ...INPUT, ownerScope: 'session:replacement' };
    const replay = await store.findReplay(replayInput);
    expect(replay?.taskId).toBe(job.taskId);
    await coordinator.reconnect(replayInput, replay!, 'session:replacement');
    await expect(registry.create({
      tool: 'control_media_buy', accountId: INPUT.accountId,
      ownerScope: 'session:replacement', overrideTaskId: INPUT.taskId,
    })).resolves.toMatchObject({
      taskId: INPUT.taskId,
      accountId: INPUT.accountId,
      ownerScope: 'session:replacement',
    });
    expect(await registry.getTask(INPUT.taskId, {
      accountId: INPUT.accountId,
      ownerScope: 'session:replacement',
    })).toMatchObject({
      accountId: INPUT.accountId,
      ownerScope: 'session:replacement',
    });
  });

  it('rebinds an SDK-cached submitted replay to the replacement session owner', async () => {
    const registry = withSellerManagedTaskReplay(createInMemoryTaskRegistry());
    await registry.create({
      tool: 'control_media_buy', accountId: INPUT.accountId,
      ownerScope: 'session:original', overrideTaskId: INPUT.taskId,
    });
    const base = {
      check: async () => ({
        kind: 'replay' as const,
        response: { structuredContent: { status: 'submitted', task_id: INPUT.taskId } },
      }),
      renew: async () => {}, save: async () => {}, release: async () => {}, close: async () => {},
      ttlSeconds: 86_400,
    };
    const replay = withSellerManagedIdempotencyReplay(base, registry);
    await replay.check({
      principal: INPUT.idempotencyPrincipal,
      key: INPUT.idempotencyKey,
      payload: [
        '@adcp/sdk-idempotency/v2', 'control_media_buy',
        ['replacement', null, INPUT.accountId], 'request-hash',
      ],
    });
    expect(await registry.getTask(INPUT.taskId, {
      accountId: INPUT.accountId,
      ownerScope: 'session:replacement',
    })).toMatchObject({
      ownerScope: 'session:replacement',
    });
  });

  it('retains the original webhook identity when rebinding a cached SDK replay', async () => {
    let sql = '';
    let values: unknown[] | undefined;
    await rebindCachedSdkReplay({
      taskId: INPUT.taskId,
      accountId: INPUT.accountId,
      idempotencyPrincipal: INPUT.idempotencyPrincipal,
      idempotencyKey: INPUT.idempotencyKey,
      ownerScope: 'session:replacement',
    }, (async (text: string, params?: unknown[]) => {
      sql = text;
      values = params;
      return { rows: [{ task_id: INPUT.taskId }], rowCount: 1 } as never;
    }) as never);
    expect(sql).toContain('UPDATE adcp_decisioning_tasks');
    expect(sql).toContain('SET owner_scope = $5');
    expect(sql).not.toContain('webhook_tenant_scope =');
    expect(sql).not.toContain('adcp_webhook_delivery_bindings');
    expect(values).toEqual([
      INPUT.taskId, INPUT.accountId, INPUT.idempotencyPrincipal,
      INPUT.idempotencyKey, 'session:replacement',
    ]);
  });

  it('recovers an enqueued job after the original worker dies before execution', async () => {
    const store = new InMemorySellerManagedControlJobStore();
    const tasks = createInMemoryTaskRegistry();
    const deadWorker = new SellerManagedControlJobCoordinator(tasks, async () => {
      throw new Error('the dead worker must never execute');
    }, store);
    await deadWorker.enqueue(INPUT);
    // The process dies after committing the outbox but before the SDK creates
    // its task row. Once the creation grace elapses, a replacement recreates
    // the correctly scoped task from the durable authorization envelope.
    store.age(INPUT.taskId, 3_000);

    const replacement = new SellerManagedControlJobCoordinator(tasks, async job => ({
      status: 'completed', media_buy_id: job.mediaBuyId, revision: job.expectedRevision + 1,
    }), store);
    await replacement.runAvailable();

    expect(await tasks.getTask(INPUT.taskId, TASK_SCOPE)).toMatchObject({
      status: 'completed',
      accountId: INPUT.accountId,
      ownerScope: INPUT.ownerScope,
      result: { media_buy_id: INPUT.mediaBuyId, revision: 5 },
    });
    expect(await store.get(INPUT.taskId)).toMatchObject({ status: 'succeeded' });
  });

  it('replays the durable mutation receipt after a crash before outbox completion', async () => {
    class CrashOnceStore extends InMemorySellerManagedControlJobStore {
      private crash = true;
      override async succeed(...args: Parameters<InMemorySellerManagedControlJobStore['succeed']>): Promise<boolean> {
        if (this.crash) {
          this.crash = false;
          throw new Error('simulated process death after mutation');
        }
        return await super.succeed(...args);
      }
      override async retry(
        claim: Parameters<InMemorySellerManagedControlJobStore['retry']>[0],
      ): Promise<boolean> {
        return await super.retry(claim, 0);
      }
    }

    const store = new CrashOnceStore();
    const tasks = createInMemoryTaskRegistry();
    await registerTask(tasks);
    const receipts = new Map<string, Record<string, unknown>>();
    let mutations = 0;
    const execute = async (job: SellerManagedControlJob) => {
      const prior = receipts.get(job.taskId);
      if (prior) return structuredClone(prior);
      mutations += 1;
      const result = { status: 'completed', media_buy_id: job.mediaBuyId, revision: 5 };
      // Models the receipt committed atomically with the media-buy revision.
      receipts.set(job.taskId, structuredClone(result));
      return result;
    };
    const firstWorker = new SellerManagedControlJobCoordinator(tasks, execute, store);
    await firstWorker.enqueue(INPUT);
    await expect(firstWorker.runAvailable()).rejects.toThrow('simulated process death');

    const replacement = new SellerManagedControlJobCoordinator(tasks, execute, store);
    await replacement.runAvailable();

    expect(mutations).toBe(1);
    expect(await tasks.getTask(INPUT.taskId, TASK_SCOPE)).toMatchObject({
      status: 'completed', result: { revision: 5 },
    });
  });

  it('fails closed when the authorized revision loses a race', async () => {
    const store = new InMemorySellerManagedControlJobStore();
    const tasks = createInMemoryTaskRegistry();
    await registerTask(tasks);
    let revision = 5;
    let mutations = 0;
    const worker = new SellerManagedControlJobCoordinator(tasks, async job => {
      if (revision !== job.expectedRevision) {
        return { errors: [{ code: 'CONFLICT', recovery: 'correctable', message: 'Revision mismatch' }] };
      }
      mutations += 1;
      revision += 1;
      return { status: 'completed', revision };
    }, store);
    await worker.enqueue(INPUT);

    await worker.runAvailable();
    expect(mutations).toBe(0);
    expect(revision).toBe(5);
    expect(await tasks.getTask(INPUT.taskId, TASK_SCOPE)).toMatchObject({
      status: 'failed', error: { code: 'CONFLICT' },
    });
  });

  it('retries an expired-lease mutex conflict without publishing a false failure', async () => {
    class ImmediateRetryStore extends InMemorySellerManagedControlJobStore {
      override async retry(
        claim: Parameters<InMemorySellerManagedControlJobStore['retry']>[0],
      ): Promise<boolean> {
        return await super.retry(claim, 0);
      }
    }

    const store = new ImmediateRetryStore();
    const tasks = createInMemoryTaskRegistry();
    await registerTask(tasks);
    await store.enqueue(INPUT);

    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>(resolve => { releaseFirst = resolve; });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    const receipt = { status: 'completed', media_buy_id: INPUT.mediaBuyId, revision: 5 };
    let receiptCommitted = false;
    const first = new SellerManagedControlJobCoordinator(tasks, async () => {
      markFirstStarted();
      await firstBlocked;
      receiptCommitted = true;
      return receipt;
    }, store);
    const firstRun = first.runAvailable();
    await firstStarted;

    // Model a stalled worker whose lease expires while it still owns the
    // media-buy mutex. A replacement sees only a transient mutex conflict.
    store.expireLease(INPUT.taskId);
    const contender = new SellerManagedControlJobCoordinator(tasks, async () => ({
      errors: [{
        code: 'CONFLICT', recovery: 'transient',
        message: 'Another media-buy mutation is in progress',
      }],
    }), store);
    await expect(contender.runAvailable()).rejects.toThrow('Another media-buy mutation is in progress');
    expect(await tasks.getTask(INPUT.taskId, TASK_SCOPE)).not.toMatchObject({ status: 'failed' });

    releaseFirst();
    await expect(firstRun).rejects.toThrow('Lost seller-control lease');

    const replacement = new SellerManagedControlJobCoordinator(tasks, async () => {
      expect(receiptCommitted).toBe(true);
      return receipt;
    }, store);
    await replacement.runAvailable();
    expect(await tasks.getTask(INPUT.taskId, TASK_SCOPE)).toMatchObject({
      status: 'completed', result: receipt,
    });
    expect(await store.get(INPUT.taskId)).toMatchObject({ status: 'succeeded' });
  });

  it('checkpoints terminal notification before marking a webhook task synchronized', async () => {
    const store = new InMemorySellerManagedControlJobStore();
    const tasks = createInMemoryTaskRegistry();
    await registerTask(tasks);
    const notified: SellerManagedControlJob[] = [];
    const worker = new SellerManagedControlJobCoordinator(
      tasks,
      async () => ({ status: 'completed', revision: 5 }),
      store,
      async job => { notified.push(structuredClone(job)); },
    );
    await worker.enqueue({
      ...INPUT,
      pushConfig: {
        url: 'https://buyer-webhook.example/task',
        operation_id: 'seller-control-op-0001',
      },
      hasWebhook: true,
    });
    await worker.runAvailable();

    expect(notified).toHaveLength(1);
    expect(notified[0]).toMatchObject({
      taskId: INPUT.taskId,
      status: 'succeeded',
      terminalAt: expect.any(String),
      pushConfig: { operation_id: 'seller-control-op-0001' },
    });
    expect(await store.get(INPUT.taskId)).toMatchObject({
      status: 'succeeded',
      taskSyncedAt: expect.any(String),
    });
  });
});
