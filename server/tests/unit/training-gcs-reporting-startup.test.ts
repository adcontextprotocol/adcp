import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  database: {} as Record<string, unknown> | undefined,
  enabled: true,
  connectDelayMs: 6000,
  pools: [] as Array<{ timeout: number; end: ReturnType<typeof vi.fn>; query: () => Promise<void> }>,
  storage: vi.fn(),
  logError: vi.fn(),
}));
vi.mock('../../src/logger.js', () => ({ createLogger: () => ({ error: state.logError }) }));
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
    const rejected = expect(module.initializeTrainingGcsReporting()).rejects.toThrow('Durable GCS reporting initialization failed');
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(state.pools[0].end).toHaveBeenCalledOnce();
    expect(() => module.getTrainingGcsReporting()).toThrow();
  });

  it('honors a shorter configured budget and closes the failed pool', async () => {
    state.database!.connectionTimeoutMillis = 2000;
    const module = await startup();
    const rejected = expect(module.initializeTrainingGcsReporting()).rejects.toThrow('Durable GCS reporting initialization failed');
    await vi.advanceTimersByTimeAsync(2000);
    await rejected;
    expect(state.pools[0].end).toHaveBeenCalledOnce();
  });

  it('still refuses a connection that exceeds the configured ten-second deadline', async () => {
    state.connectDelayMs = 11000;
    const module = await startup();
    const rejected = expect(module.initializeTrainingGcsReporting()).rejects.toThrow('Durable GCS reporting initialization failed');
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
    await expect(module.initializeTrainingGcsReporting()).rejects.toThrow('Reporting requires the application PostgreSQL primary');
    expect(state.pools).toHaveLength(0);
  });
});
