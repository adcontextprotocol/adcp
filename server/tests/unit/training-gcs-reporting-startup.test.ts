import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportingNotificationAbandonedError, ReportingNotificationUnsettledError } from '@adcp/reporting-storage/notifications';

const state = vi.hoisted(() => ({
  database: {} as Record<string, unknown> | undefined,
  enabled: true,
  connectDelayMs: 6000,
  pools: [] as Array<{ timeout: number; end: ReturnType<typeof vi.fn>; query: () => Promise<void> }>,
  storage: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock('../../src/logger.js', () => ({ createLogger: () => ({ error: state.logError, warn: state.logWarn }) }));
vi.mock('../../src/config.js', () => ({ getDatabaseConfig: () => state.database }));
vi.mock('../../src/training-agent/gcs-reporting-config.js', () => ({
  trainingGcsReportingConfig: () => state.enabled ? { bucket: 'private-canary', credentialsFile: '/run/gcp.json' } : undefined,
  TRAINING_REPORTING_SCHEMA: 'training_reporting_gcs',
  TRAINING_REPORTING_LIMITS: {},
}));
vi.mock('pg', () => ({
  Pool: class {
    timeout: number;
    end = vi.fn().mockResolvedValue(undefined);
    on = vi.fn();
    constructor(options: { connectionTimeoutMillis: number }) {
      this.timeout = options.connectionTimeoutMillis;
      state.pools.push(this);
    }
    query() {
      return new Promise<void>((resolve, reject) => {
        const connected = setTimeout(() => { clearTimeout(deadline); resolve(); }, state.connectDelayMs);
        const deadline = setTimeout(() => {
          clearTimeout(connected);
          reject(new Error('Connection terminated due to connection timeout'));
        }, this.timeout);
      });
    }
  },
}));
vi.mock('@google-cloud/storage', () => ({ Storage: class { constructor() { state.storage(); } } }));
vi.mock('../../src/training-agent/webhooks.js', () => ({ getWebhookSigningMaterial: vi.fn() }));
vi.mock('../../src/training-agent/webhook-challenge.js', () => ({ proveAccountWebhookControl: vi.fn() }));
vi.mock('../../src/training-agent/reporting-reliability.js', () => ({
  resolveReportingAccountDurably: vi.fn(), TRAINING_REPORTING_ROW_SCHEMA_BYTES: '',
}));
vi.mock('../../src/training-agent/gcs-reporting-source.js', () => ({
  GCS_OFFERING_ID: '', GCS_REPORT_DEFINITION_ID: '', TRAINING_GCS_DEFINITION_BYTES: '',
  TRAINING_GCS_CANONICALIZATION_BYTES: '', trainingGcsCanonicalization: vi.fn(),
  sha256: vi.fn(), trainingConstituents: vi.fn(), trainingGcsAdapter: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  state.database = { connectionString: 'postgresql://fixture', connectionTimeoutMillis: 10000 };
  state.enabled = true;
  state.connectDelayMs = 6000;
  state.pools.length = 0;
  state.storage.mockClear();
  state.logError.mockClear();
  state.logWarn.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function startup() {
  const module = await import('../../src/training-agent/gcs-reporting.js');
  vi.spyOn(module.TrainingGcsReporting, 'create').mockImplementation(async (_config, db) => {
    await db.query('SELECT 1');
    return { assertServing: vi.fn() } as unknown as typeof module.TrainingGcsReporting.prototype;
  });
  return module;
}

describe('private GCS reporting startup connection budget', () => {
  it.each(['40P01', '55P03', '42703', '08006'])('reports nested SQLSTATE %s without database payloads', async code => {
    const module = await import('../../src/training-agent/gcs-reporting.js');
    const databaseError = Object.assign(new Error('private SQL and account values'), { code });
    module.logTrainingReportingSchedulerFailure(new Error('Reporting notification recovery claim failed', {
      cause: new Error('storage wrapper', { cause: databaseError }),
    }));
    expect(state.logError).toHaveBeenCalledWith({
      diagnostic: 'Reporting notification recovery claim failed', databaseCode: code,
    }, 'Durable reporting scheduler failed');
    expect(JSON.stringify(state.logError.mock.calls)).not.toContain('private SQL');
  });

  it('handles cyclic causes and hostile descriptors without interrupting the scheduler', async () => {
    const module = await import('../../src/training-agent/gcs-reporting.js');
    const cyclic = new Error('scheduler failure');
    cyclic.cause = cyclic;
    const hostile = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('hostile'); } });
    for (const error of [cyclic, hostile, Object.assign(new Error('failure'), { code: 'not a SQLSTATE' })]) {
      expect(() => module.logTrainingReportingSchedulerFailure(error)).not.toThrow();
    }
    expect(state.logError).toHaveBeenCalledTimes(3);
    for (const [details] of state.logError.mock.calls) expect(details.databaseCode).toBeUndefined();
  });

  it('logs the underlying startup failure with its causes and no credentials', async () => {
    const module = await import('../../src/training-agent/gcs-reporting.js');
    const gcs = Object.assign(new Error(
      'reporting@example.iam.gserviceaccount.com does not have storage.objects.create access; Authorization: Bearer ya29.a0secret-token',
    ), { name: 'ApiError', code: 403 });
    const credential = Object.assign(new Error(
      'invalid_grant: {"private_key": "-----BEGIN PRIVATE KEY-----\\nMIIsecret\\n-----END PRIVATE KEY-----", "client_secret": "s3cr3t"} via https://user:pass@oauth2.example/token',
    ), { cause: gcs });
    vi.spyOn(module.TrainingGcsReporting, 'create').mockRejectedValue(new Error('Reporting object fence failed', { cause: credential }));
    await expect(module.initializeTrainingGcsReporting([])).rejects.toThrow('Durable GCS reporting initialization failed');
    expect(state.pools[0].end).toHaveBeenCalledOnce();

    expect(state.logError).toHaveBeenCalledWith(expect.objectContaining({ failure: expect.objectContaining({
      name: 'Error',
      message: 'Reporting object fence failed',
      at: expect.any(Array),
      cause: expect.objectContaining({
        message: expect.stringContaining('invalid_grant'),
        cause: expect.objectContaining({ name: 'ApiError', code: 403, message: expect.stringContaining('storage.objects.create') }),
      }),
    }) }), 'Durable GCS reporting initialization failed');
    const logged = JSON.stringify(state.logError.mock.calls);
    for (const secret of ['ya29.a0secret-token', 'MIIsecret', 's3cr3t', 'user:pass']) expect(logged).not.toContain(secret);
  });

  it('describes cyclic, primitive and hostile startup failures without throwing', async () => {
    const module = await import('../../src/training-agent/gcs-reporting.js');
    const cyclic = new Error('cyclic');
    cyclic.cause = cyclic;
    expect(module.describeReportingInitFailure(cyclic)).toMatchObject({ message: 'cyclic', cause: '[cyclic cause]' });
    expect(module.describeReportingInitFailure('token=abc123 failed')).toEqual({ message: 'token=[redacted] failed' });
    const hostile = new Proxy({}, { get() { throw new Error('hostile'); }, getOwnPropertyDescriptor() { throw new Error('hostile'); } });
    expect(module.describeReportingInitFailure(hostile)).toEqual({ message: '[undescribable error]' });
  });

  it('retries a failed startup with backoff on a fresh pool, and logs every attempt', async () => {
    const module = await import('../../src/training-agent/gcs-reporting.js');
    const create = vi.spyOn(module.TrainingGcsReporting, 'create')
      .mockRejectedValueOnce(new Error('PostgresReportingManagedDeliveryStore database connection failed', {
        cause: new Error('Connection terminated due to connection timeout'),
      }))
      .mockRejectedValueOnce(new Error('PostgresReportingManagedDeliveryStore database connection failed'))
      .mockResolvedValue({ assertServing: vi.fn() } as unknown as typeof module.TrainingGcsReporting.prototype);
    const initializing = module.initializeTrainingGcsReporting([1_000, 2_000, 4_000]);
    const completed = expect(initializing).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(3_000);
    await completed;
    expect(create).toHaveBeenCalledTimes(3);
    expect(state.pools).toHaveLength(3);
    expect(state.pools[0].end).toHaveBeenCalledOnce();
    expect(state.pools[1].end).toHaveBeenCalledOnce();
    expect(state.pools[2].end).not.toHaveBeenCalled();
    expect(state.logError.mock.calls.map(([details]) => [details.attempt, details.attempts, details.retryInMs])).toEqual([[1, 4, 1_000], [2, 4, 2_000]]);
    expect(state.logError.mock.calls[0][0].failure.cause).toMatchObject({ message: 'Connection terminated due to connection timeout' });
    expect(state.logWarn).toHaveBeenCalledWith({ attempt: 3, attempts: 4 }, 'Durable GCS reporting initialized after a retry');
    expect(module.getTrainingGcsReporting()).toBeDefined();
  });

  it('still fails the boot once every attempt has failed', async () => {
    const module = await import('../../src/training-agent/gcs-reporting.js');
    const create = vi.spyOn(module.TrainingGcsReporting, 'create').mockRejectedValue(new Error('database connection failed'));
    const rejected = expect(module.initializeTrainingGcsReporting([1_000, 2_000])).rejects.toThrow('Durable GCS reporting initialization failed');
    await vi.advanceTimersByTimeAsync(3_000);
    await rejected;
    expect(create).toHaveBeenCalledTimes(3);
    for (const pool of state.pools) expect(pool.end).toHaveBeenCalledOnce();
    expect(state.logError.mock.calls.at(-1)![0]).toMatchObject({ attempt: 3, attempts: 3 });
    expect(state.logError.mock.calls.at(-1)![0].retryInMs).toBeUndefined();
    expect(() => module.getTrainingGcsReporting()).toThrow();
  });

  it('waits about 90 seconds across six attempts by default', async () => {
    const module = await import('../../src/training-agent/gcs-reporting.js');
    const delays = module.TRAINING_REPORTING_INIT_RETRY_DELAYS_MS;
    expect(delays).toHaveLength(5);
    // Six 10 s connect budgets plus the waits between them.
    expect(6 * 10_000 + delays.reduce((total, delay) => total + delay, 0)).toBeLessThanOrEqual(95_000);
  });

  it('allows a cold primary connection longer than five seconds within the configured Fly budget', async () => {
    const module = await startup();
    const initializing = module.initializeTrainingGcsReporting();
    const completed = expect(initializing).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(6000);
    await completed;
    expect(module.getTrainingGcsReporting()).toBeDefined();
    expect(state.pools[0].end).not.toHaveBeenCalled();
    await module.initializeTrainingGcsReporting();
    expect(state.pools).toHaveLength(1);
  });

  it.each([undefined, 0])('retains a finite five-second fallback for timeout %s', async timeout => {
    state.database!.connectionTimeoutMillis = timeout;
    const module = await startup();
    const rejected = expect(module.initializeTrainingGcsReporting([])).rejects.toThrow('Durable GCS reporting initialization failed');
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(state.pools[0].end).toHaveBeenCalledOnce();
    expect(() => module.getTrainingGcsReporting()).toThrow();
  });

  it('honors a shorter configured budget and closes the failed pool', async () => {
    state.database!.connectionTimeoutMillis = 2000;
    const module = await startup();
    const rejected = expect(module.initializeTrainingGcsReporting([])).rejects.toThrow('Durable GCS reporting initialization failed');
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    expect(state.pools[0].end).toHaveBeenCalledOnce();
  });

  it('still refuses a connection that exceeds the configured ten-second deadline', async () => {
    state.connectDelayMs = 11000;
    const module = await startup();
    const rejected = expect(module.initializeTrainingGcsReporting([])).rejects.toThrow('Durable GCS reporting initialization failed');
    await vi.advanceTimersByTimeAsync(10000);
    await rejected;
    expect(state.pools[0].end).toHaveBeenCalledOnce();
  });

  it('does not initialize a reporting pool or Storage while disabled', async () => {
    state.enabled = false;
    const module = await startup();
    await module.initializeTrainingGcsReporting();
    expect(state.pools).toHaveLength(0);
    expect(state.storage).not.toHaveBeenCalled();
  });

  it('refuses missing primary configuration before opening connections', async () => {
    state.database = undefined;
    const module = await startup();
    await expect(module.initializeTrainingGcsReporting([])).rejects.toThrow('Reporting requires the application PostgreSQL primary');
    expect(state.pools).toHaveLength(0);
  });
});

describe('durable reporting scheduler failure logging', () => {
  const scope = { kind: 'account', tenantId: 'tenant-a', principalId: 'principal-secret', accountId: 'account-a' };
  const UNSETTLED = 'Reporting notification delivery is not settled for 1 recipient(s); retrying';
  const FINAL = 'Reporting notification delivery is not settled for 1 recipient(s); attempt 100 of 100, not retrying';
  const recipient = { scope, subscriberId: 'sub-1', destinationGeneration: 'gen-secret', reason: 'delivery_failed', finalStatus: 503 };

  /** A real SDK instance; `fields` are redefined as own data properties afterwards, past what the constructor would accept. */
  function unsettled(fields: Record<string, unknown> = {}, input: Record<string, unknown> = {}) {
    const error = new ReportingNotificationUnsettledError({
      transitionId: 'transition-1', unsettled: 1, attempt: 1, maxAttempts: 100, recipients: [recipient as never], ...input,
    });
    for (const [key, value] of Object.entries(fields)) {
      Object.defineProperty(error, key, { value, writable: true, enumerable: true, configurable: true });
    }
    return error;
  }
  function abandoned(cause: unknown = unsettled()) {
    return new ReportingNotificationAbandonedError({ transitionId: 'transition-1', attempt: 100, maxAttempts: 100, cause });
  }
  /** Shaped like an SDK error class, but not an instance of it. */
  function lookalike(name: string, message: string, fields: Record<string, unknown> = {}) {
    return Object.assign(new Error(message), { name }, fields);
  }
  async function logger() {
    return (await import('../../src/training-agent/gcs-reporting.js')).logTrainingReportingSchedulerFailure;
  }

  it('logs a typed unsettled retry at warn with non-secret subscriber identifiers', async () => {
    (await logger())(unsettled());
    expect(state.logError).not.toHaveBeenCalled();
    expect(state.logWarn).toHaveBeenCalledOnce();
    expect(state.logWarn).toHaveBeenCalledWith({
      diagnostic: UNSETTLED, transitionId: 'transition-1', unsettled: 1, attempt: 1, maxAttempts: 100,
      subscribers: [{ subscriberId: 'sub-1', accountId: 'account-a', reason: 'delivery_failed', finalStatus: 503 }],
    }, 'Reporting notification delivery is retrying');
    const logged = JSON.stringify(state.logWarn.mock.calls);
    for (const leaked of ['principal-secret', 'gen-secret', 'principalId', 'destinationGeneration', 'http']) {
      expect(logged).not.toContain(leaked);
    }
  });

  it.each([UNSETTLED, FINAL])('downgrades only the typed error: a plain Error saying %j stays at error', async message => {
    (await logger())(new Error(message));
    expect(state.logWarn).not.toHaveBeenCalled();
    expect(state.logError).toHaveBeenCalledOnce();
    expect(state.logError).toHaveBeenCalledWith(
      { diagnostic: message, databaseCode: undefined }, 'Durable reporting scheduler failed');
  });

  it('keeps a name-only lookalike of the unsettled error at error, with no retry details', async () => {
    const impostor = lookalike('ReportingNotificationUnsettledError', UNSETTLED, {
      transitionId: 'transition-1', unsettled: 1, attempt: 1, maxAttempts: 100, recipients: [recipient],
    });
    (await logger())(impostor);
    expect(state.logWarn).not.toHaveBeenCalled();
    expect(state.logError).toHaveBeenCalledOnce();
    expect(state.logError).toHaveBeenCalledWith(
      { diagnostic: UNSETTLED, databaseCode: undefined }, 'Durable reporting scheduler failed');
  });

  it('does not throw, or warn, when the prototype chain is hostile', async () => {
    const log = await logger();
    const hostile = new Proxy(new Error(UNSETTLED), { getPrototypeOf() { throw new Error('hostile prototype'); } });
    expect(() => log(hostile)).not.toThrow();
    expect(state.logWarn).not.toHaveBeenCalled();
    expect(state.logError).toHaveBeenCalledOnce();
  });

  it('still warns on the final-attempt message because abandonment is reported separately', async () => {
    (await logger())(unsettled({}, { attempt: 100 }));
    expect(state.logError).not.toHaveBeenCalled();
    expect(state.logWarn).toHaveBeenCalledWith(
      expect.objectContaining({ diagnostic: FINAL, attempt: 100, maxAttempts: 100 }),
      'Reporting notification delivery is retrying',
    );
  });

  it('logs abandonment at error with its identifiers and no subscribers', async () => {
    const error = abandoned();
    (await logger())(error);
    expect(state.logWarn).not.toHaveBeenCalled();
    expect(state.logError).toHaveBeenCalledOnce();
    expect(state.logError).toHaveBeenCalledWith({
      diagnostic: error.message, databaseCode: undefined,
      transitionId: 'transition-1', attempt: 100, maxAttempts: 100,
    }, 'Durable reporting scheduler failed');
    expect(state.logError.mock.calls[0][0]).not.toHaveProperty('subscribers');
    expect(JSON.stringify(state.logError.mock.calls)).not.toContain('gen-secret');
  });

  it('lets a nested database code beat the typed unsettled error', async () => {
    const databaseError = Object.assign(new Error('private SQL'), { code: '40P01' });
    (await logger())(unsettled({ cause: new Error('storage wrapper', { cause: databaseError }) }));
    expect(state.logWarn).not.toHaveBeenCalled();
    expect(state.logError).toHaveBeenCalledWith(
      expect.objectContaining({ databaseCode: '40P01' }), 'Durable reporting scheduler failed');
  });

  it.each([
    ['a port that did not freeze', new Error('Reporting notification port did not freeze its recipient set; refusing')],
    ['a retryable suppression', lookalike('ReportingNotificationRetryableSuppressionError', 'Reporting notification delivery was suppressed')],
  ])('keeps %s at error', async (_label, error) => {
    (await logger())(error);
    expect(state.logWarn).not.toHaveBeenCalled();
    expect(state.logError).toHaveBeenCalledOnce();
    expect(state.logError.mock.calls[0][0]).toEqual({ diagnostic: error.message, databaseCode: undefined });
  });

  it('never throws on hostile recipients and never invokes an accessor', async () => {
    const log = await logger();
    let getterCalls = 0;
    const getterRecipient = {};
    for (const key of ['subscriberId', 'reason', 'finalStatus', 'scope']) {
      Object.defineProperty(getterRecipient, key, { get() { getterCalls += 1; throw new Error('hostile getter'); } });
    }
    const hostileProxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('hostile'); } });
    const wrongTypes = { scope: 'nope', subscriberId: 42, reason: {}, finalStatus: '503' };
    // A real instance whose fields are then redefined past what the constructor accepts.
    const cases = [
      unsettled({ recipients: 'not an array' }),
      unsettled({ recipients: { length: 1, 0: {} } }),
      unsettled({ recipients: [null, undefined, 7, 'x', [], getterRecipient, hostileProxy, wrongTypes] }),
      unsettled({ transitionId: { toString() { throw new Error('hostile'); } }, attempt: 1.5, maxAttempts: Infinity }),
    ];
    for (const error of cases) expect(() => log(error)).not.toThrow();
    expect(getterCalls).toBe(0);
    expect(state.logError).not.toHaveBeenCalled();
    expect(state.logWarn).toHaveBeenCalledTimes(cases.length);
    const calls = state.logWarn.mock.calls;
    expect(calls[0][0].subscribers).toBeUndefined();
    expect(calls[1][0].subscribers).toBeUndefined();
    expect(calls[2][0].subscribers).toEqual(Array(8).fill({}));
    expect(calls[3][0]).not.toHaveProperty('transitionId');
    expect(calls[3][0]).not.toHaveProperty('attempt');
    expect(calls[3][0]).not.toHaveProperty('maxAttempts');
  });

  it('projects hostile recipient arrays without running any accessor, array method or proxy trap that throws', async () => {
    const log = await logger();
    let calls = 0;
    const boom = () => { calls += 1; throw new Error('hostile'); };
    const trap = () => { throw new Error('hostile trap'); };
    const normal = { scope, subscriberId: 'sub-1', reason: 'delivery_failed', finalStatus: 503 };
    const normalProjection = { subscriberId: 'sub-1', accountId: 'account-a', reason: 'delivery_failed', finalStatus: 503 };
    const second = { scope, subscriberId: 'sub-2' };

    const throwingIndex: unknown[] = [normal, second];
    Object.defineProperty(throwingIndex, '0', { get: boom, configurable: true });
    const throwingMethods: unknown[] = [normal, second];
    for (const key of ['slice', 'map']) Object.defineProperty(throwingMethods, key, { get: boom, configurable: true });
    const { proxy: revoked, revoke } = Proxy.revocable([], {});
    revoke();
    const throwingDescriptorTrap = new Proxy([normal], { getOwnPropertyDescriptor: trap });
    // Unreadable length: the trap throws for `length` only, then (second proxy) lies about it, which the proxy invariant rejects.
    const throwingLength = new Proxy([normal], {
      getOwnPropertyDescriptor(target, key) { if (key === 'length') trap(); return Reflect.getOwnPropertyDescriptor(target, key); },
    });
    const accessorLength = new Proxy([normal], {
      getOwnPropertyDescriptor(target, key) {
        return key === 'length' ? { get: trap, configurable: true, enumerable: false } : Reflect.getOwnPropertyDescriptor(target, key);
      },
    });

    const expected: [string, unknown, unknown][] = [
      ['throwing index getter', throwingIndex, [{}, { subscriberId: 'sub-2', accountId: 'account-a' }]],
      ['throwing slice and map getters', throwingMethods, [normalProjection, { subscriberId: 'sub-2', accountId: 'account-a' }]],
      ['revoked proxy', revoked, undefined],
      ['throwing descriptor trap', throwingDescriptorTrap, []],
      ['unreadable length', throwingLength, []],
      ['length reported as an accessor', accessorLength, []],
    ];
    for (const [label, recipients, subscribers] of expected) {
      state.logWarn.mockClear();
      state.logError.mockClear();
      expect(() => log(unsettled({ recipients })), label).not.toThrow();
      expect(state.logError, label).not.toHaveBeenCalled();
      expect(state.logWarn, label).toHaveBeenCalledOnce();
      const [details, message] = state.logWarn.mock.calls[0];
      expect(message, label).toBe('Reporting notification delivery is retrying');
      if (subscribers === undefined) expect(details, label).not.toHaveProperty('subscribers');
      else expect(details.subscribers, label).toEqual(subscribers);
    }
    expect(calls).toBe(0);
  });

  it('logs at most ten recipients, whether the constructor or a redefined field supplies them', async () => {
    const many = Array.from({ length: 15 }, (_, index) => ({
      scope, subscriberId: `sub-${index}`, reason: 'delivery_failed', finalStatus: 503,
    }));
    const log = await logger();
    // The SDK constructor already caps at ten; redefining the field proves the logger caps independently.
    log(unsettled({}, { unsettled: 15, recipients: many }));
    log(unsettled({ recipients: many }, { unsettled: 15 }));
    for (const [details] of state.logWarn.mock.calls) {
      expect(details.unsettled).toBe(15);
      expect(details.subscribers).toHaveLength(10);
      expect(details.subscribers.at(-1).subscriberId).toBe('sub-9');
    }
    expect(state.logWarn).toHaveBeenCalledTimes(2);
  });
});
