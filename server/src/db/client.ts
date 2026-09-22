import { Client, Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseConfig } from "../config.js";
import { createLogger } from "../logger.js";

const logger = createLogger("db");

const SLOW_QUERY_THRESHOLD_MS = 500;

let pool: Pool | null = null;
let poolConfig: DatabaseConfig | null = null;
let healthClient: Client | null = null;
let healthClientConnectPromise: Promise<Client> | null = null;
export interface DatabasePoolSnapshot {
  max: number;
  total: number;
  idle: number;
  waiting: number;
  saturated: boolean;
}

export interface HealthCheckDiagnostics {
  timeout_ms: number;
  attempts: number;
  connect_ms: number;
  query_ms: number;
  cleanup_ms: number;
  total_ms: number;
  pool: DatabasePoolSnapshot;
}

type HealthCheckError = Error & { healthCheckDiagnostics?: HealthCheckDiagnostics };

let healthCheckPromise: Promise<HealthCheckDiagnostics> | null = null;
const healthClientClosePromises = new WeakMap<Client, Promise<void>>();
interface QueryDeadlineContext {
  deadlineMs: number;
  readOnly: boolean;
}

const queryDeadline = new AsyncLocalStorage<QueryDeadlineContext>();

/** Callback invoked on pool-level errors (set via onPoolError). */
let poolErrorCallback: ((err: Error) => void) | null = null;

/**
 * Register a callback for pool-level errors (e.g. to escalate to Slack).
 * Only one callback is supported; later calls replace earlier ones.
 */
export function onPoolError(cb: (err: Error) => void): void {
  poolErrorCallback = cb;
}

/**
 * Initialize database connection pool
 */
export function initializeDatabase(config: DatabaseConfig): Pool {
  if (pool) {
    return pool;
  }
  poolConfig = config;

  pool = new Pool({
    connectionString: config.connectionString,
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl,
    max: config.maxPoolSize ?? 8,
    min: config.minPoolSize ?? 0,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30000,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5000,
    allowExitOnIdle: true,
  });

  pool.on("error", (err) => {
    console.error("Unexpected database pool error:", err);
    poolErrorCallback?.(err);
  });

  console.log("Database connection pool initialized");
  return pool;
}

/**
 * Get database pool instance
 */
export function getPool(): Pool {
  if (!pool) {
    throw new Error("Database not initialized. Call initializeDatabase() first.");
  }
  return pool;
}

/** Low-cardinality pool state for slow/error logs and health diagnostics. */
export function getDatabasePoolSnapshot(): DatabasePoolSnapshot {
  const max = pool?.options.max ?? 8;
  const total = pool?.totalCount ?? 0;
  const idle = pool?.idleCount ?? 0;
  const waiting = pool?.waitingCount ?? 0;
  return { max, total, idle, waiting, saturated: total >= max && idle === 0 };
}

/** Transient connection errors that are safe to retry once. */
const TRANSIENT_CONNECTION_ERRORS = new Set([
  "connection_reset",
  "ECONNRESET",
  "EPIPE",
  "57P01", // admin_shutdown
  "57P03", // cannot_connect_now
  "08006", // connection_failure
  "08003", // connection_does_not_exist
]);

// pg-pool throws plain Errors with these messages and no `code` when the
// other side closes a pooled connection between checkout and use. Matched
// as substrings rather than exact set hits.
const TRANSIENT_CONNECTION_MESSAGES = [
  "Connection terminated unexpectedly",
  "Connection terminated due to connection timeout",
  "Client has encountered a connection error and is not queryable",
  "timeout exceeded when trying to connect",
  "timeout expired",
];

export function isTransientConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as any).code || "";
  const message = err.message || "";
  if (TRANSIENT_CONNECTION_ERRORS.has(code) || TRANSIENT_CONNECTION_ERRORS.has(message)) {
    return true;
  }
  return TRANSIENT_CONNECTION_MESSAGES.some((m) => message.includes(m));
}

/**
 * Execute a parameterized query. All callers must use $1, $2, etc. placeholders
 * with the params array -- never concatenate user input into the text argument.
 *
 * Automatically retries once on transient connection errors.
 */
export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  const deadline = queryDeadline.getStore();
  if (deadline !== undefined) {
    return queryWithTimeout<T>(text, params, deadline.deadlineMs - Date.now());
  }
  const p = getPool();
  const start = process.hrtime.bigint();
  try {
    return await p.query<T>(text, params);
  } catch (err) {
    if (isTransientConnectionError(err)) {
      logger.warn(
        { err, pool: getDatabasePoolSnapshot() },
        "Transient DB connection error, retrying query",
      );
      return p.query<T>(text, params);
    }
    throw err;
  } finally {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
      logger.warn(
        { duration_ms: Math.round(durationMs), pool: getDatabasePoolSnapshot() },
        "Slow database query",
      );
    }
  }
}

/** Apply one absolute datastore deadline to all query() calls in work. */
export function withDatabaseDeadline<T>(
  deadlineMs: number,
  work: () => Promise<T>,
  options: { readOnly?: boolean } = {},
): Promise<T> {
  return queryDeadline.run({ deadlineMs, readOnly: options.readOnly ?? true }, work);
}

export class DatabaseQueryDeadlineExceededError extends Error {
  readonly code = '57014' as const;
  readonly retryable = true as const;

  constructor() {
    super('Database query deadline exceeded');
    this.name = 'DatabaseQueryDeadlineExceededError';
  }
}

function databaseDeadlineExceededError(): DatabaseQueryDeadlineExceededError {
  return new DatabaseQueryDeadlineExceededError();
}

/**
 * Await one client operation for no longer than the caller's absolute
 * deadline. Promise.race keeps observing a late rejection, while callers
 * destroy the client because a late result leaves its protocol/transaction
 * state unknowable.
 */
async function clientOperationBeforeDeadline<T>(
  operation: () => Promise<T>,
  deadlineMs: number,
): Promise<T> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw databaseDeadlineExceededError();

  const pending = Promise.resolve().then(operation);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(databaseDeadlineExceededError()), remainingMs);
  });

  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function isDefinitivePostgresError(error: unknown): boolean {
  if (!(error instanceof Error) || error instanceof DatabaseQueryDeadlineExceededError) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string'
    && /^[0-9A-Z]{5}$/.test(code)
    && !isTransientConnectionError(error);
}

/**
 * Check out a pooled client without allowing pool saturation to outlive the
 * caller's absolute deadline. A client delivered after the timer wins is
 * released immediately so a timed-out request cannot leak a pool slot.
 */
async function checkoutClientBeforeDeadline(deadlineMs: number): Promise<PoolClient> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw databaseDeadlineExceededError();

  const checkout = getPool().connect();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      reject(databaseDeadlineExceededError());
    }, remainingMs);
  });

  try {
    return await Promise.race([checkout, deadline]);
  } catch (error) {
    if (timedOut) {
      void checkout.then(
        (lateClient) => lateClient.release(),
        () => undefined,
      );
    }
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function getClientBeforeDeadline(
  deadlineMs: number,
  retryTransientCheckout: boolean,
): Promise<PoolClient> {
  const attempts = retryTransientCheckout ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await checkoutClientBeforeDeadline(deadlineMs);
    } catch (error) {
      if (attempt === attempts - 1 || !isTransientConnectionError(error) || Date.now() >= deadlineMs) {
        throw error;
      }
      console.warn('Transient DB connection error, retrying client checkout:', (error as Error).message);
    }
  }
  throw databaseDeadlineExceededError();
}

/** Checkout a transactional client within a bounded pool-wait budget. */
export function getClientWithDeadline(timeoutMs: number): Promise<PoolClient> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Client checkout timeout must be positive');
  }
  return getClientBeforeDeadline(Date.now() + timeoutMs, true);
}

/**
 * Execute one query with deadline-bounded pool checkout plus server-enforced
 * statement and lock deadlines.
 *
 * Use this for public read paths whose inputs can select unusually large
 * registry fan-outs. The transaction-local settings ensure PostgreSQL stops
 * the work at the same deadline as the caller instead of leaving an orphaned
 * backend query consuming a pool slot.
 */
export async function queryWithTimeout<T extends QueryResultRow = any>(
  text: string,
  params: any[] | undefined,
  timeoutMs: number,
  options: { retryTransientCheckout?: boolean; deadlineMs?: number } = {},
): Promise<QueryResult<T>> {
  const inheritedDeadline = queryDeadline.getStore();
  const deadlineMs = Math.min(
    options.deadlineMs ?? Date.now() + timeoutMs,
    inheritedDeadline?.deadlineMs ?? Number.POSITIVE_INFINITY,
  );
  const client = await getClientBeforeDeadline(
    deadlineMs,
    options.retryTransientCheckout ?? true,
  );
  let transactionStarted = false;
  let clientStateUncertain = false;

  const run = async <R>(
    operation: () => Promise<R>,
    phase: 'begin' | 'configuration' | 'statement' | 'commit' | 'rollback',
  ): Promise<R> => {
    try {
      return await clientOperationBeforeDeadline(operation, deadlineMs);
    } catch (error) {
      // A client-side deadline can win while pg is still processing any query.
      // Connection-style failures have no trustworthy server acknowledgement.
      // COMMIT failures are always ambiguous: the transaction may be durable
      // even though its acknowledgement never reached this process.
      if (error instanceof DatabaseQueryDeadlineExceededError
          || !isDefinitivePostgresError(error)
          || phase === 'commit'
          || phase === 'rollback') {
        clientStateUncertain = true;
      }
      throw error;
    }
  };

  try {
    const effectiveTimeoutMs = deadlineMs - Date.now();
    if (effectiveTimeoutMs <= 0) {
      throw databaseDeadlineExceededError();
    }
    await run(
      () => client.query(inheritedDeadline?.readOnly === false ? 'BEGIN' : 'BEGIN READ ONLY'),
      'begin',
    );
    transactionStarted = true;
    await run(
      () => client.query("SELECT set_config('statement_timeout', $1, true)", [
        `${effectiveTimeoutMs}ms`,
      ]),
      'configuration',
    );
    await run(
      () => client.query("SELECT set_config('lock_timeout', $1, true)", [
        `${Math.min(effectiveTimeoutMs, 2_000)}ms`,
      ]),
      'configuration',
    );
    const result = await run(() => client.query<T>(text, params), 'statement');
    await run(() => client.query('COMMIT'), 'commit');
    transactionStarted = false;
    return result;
  } catch (error) {
    // Never queue ROLLBACK behind an operation that may still be in flight.
    // If the prior outcome is definite, cleanup must still finish inside the
    // same deadline before this client can be considered reusable.
    if (transactionStarted && !clientStateUncertain) {
      await run(() => client.query('ROLLBACK'), 'rollback').catch((rollbackError) => {
        logger.warn({ err: rollbackError }, 'Timed query rollback failed');
      });
      if (!clientStateUncertain) transactionStarted = false;
    }
    throw error;
  } finally {
    if (clientStateUncertain || transactionStarted) client.release(true);
    else client.release();
  }
}

/**
 * Get a client from the pool for transactions.
 */
export async function getClient(): Promise<PoolClient> {
  const p = getPool();
  try {
    return await p.connect();
  } catch (err) {
    if (isTransientConnectionError(err)) {
      logger.warn(
        { err, pool: getDatabasePoolSnapshot() },
        "Transient DB connection error, retrying client checkout",
      );
      return p.connect();
    }
    throw err;
  }
}

/**
 * Open a one-off database connection outside the application pool.
 *
 * Use this only for session-scoped work that must retain one connection while
 * waiting on slow external systems (for example, a PostgreSQL advisory lock).
 * Callers own the returned client and must close it with `client.end()`.
 */
export async function getDedicatedClient(): Promise<Client> {
  if (!poolConfig) {
    throw new Error("Database not initialized. Call initializeDatabase() first.");
  }
  const config = poolConfig;

  const connect = async (): Promise<Client> => {
    const client = new Client({
      connectionString: config.connectionString,
      host: config.host,
      port: config.port,
      database: config.database,
      user: config.user,
      password: config.password,
      ssl: config.ssl,
      connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5000,
    });
    try {
      await client.connect();
      return client;
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
  };

  try {
    return await connect();
  } catch (err) {
    if (isTransientConnectionError(err)) {
      console.warn("Transient DB connection error, retrying dedicated connection:", (err as Error).message);
      return connect();
    }
    throw err;
  }
}

/**
 * Get a reusable connection dedicated to health checks. Keeping this outside
 * the application pool prevents saturated worker traffic from making a
 * reachable database look down, while reuse avoids opening a fresh TLS/DB
 * session for every Fly probe on every machine.
 */
interface MutableHealthCheckTimings {
  attempts: number;
  connectMs: number;
  queryMs: number;
  cleanupMs: number;
}

function healthTimeout(message: string): Error {
  return new Error(message);
}

async function healthOperationBeforeDeadline<T>(
  operation: () => Promise<T>,
  deadlineMs: number,
  timeoutMessage: string,
): Promise<T> {
  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) throw healthTimeout(timeoutMessage);

  const pending = Promise.resolve().then(operation);
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(healthTimeout(timeoutMessage)), remainingMs);
  });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function getHealthClient(
  deadlineMs: number,
  timings: MutableHealthCheckTimings,
): Promise<Client> {
  if (!poolConfig) {
    throw new Error("Database not initialized. Call initializeDatabase() first.");
  }

  if (healthClient) return healthClient;
  if (healthClientConnectPromise) return healthClientConnectPromise;

  const remainingMs = Math.max(1, deadlineMs - Date.now());
  const client = new Client({
    connectionString: poolConfig.connectionString,
    host: poolConfig.host,
    port: poolConfig.port,
    database: poolConfig.database,
    user: poolConfig.user,
    password: poolConfig.password,
    ssl: poolConfig.ssl,
    connectionTimeoutMillis: Math.min(poolConfig.connectionTimeoutMillis ?? remainingMs, remainingMs),
  });

  client.on('error', (err) => {
    if (healthClient === client) healthClient = null;
    logger.warn({ err }, 'Dedicated health check connection failed while idle');
    void discardHealthClient(client, Date.now() + 1000);
  });

  const connectPromise = (async () => {
    const connectStartedAt = Date.now();
    try {
      await healthOperationBeforeDeadline(
        () => client.connect(),
        deadlineMs,
        'health check connection timed out',
      );
      timings.connectMs += Date.now() - connectStartedAt;
      healthClient = client;
      return client;
    } catch (error) {
      timings.connectMs += Date.now() - connectStartedAt;
      const cleanupStartedAt = Date.now();
      await discardHealthClient(client, deadlineMs);
      timings.cleanupMs += Date.now() - cleanupStartedAt;
      throw error;
    }
  })();
  healthClientConnectPromise = connectPromise;

  try {
    return await connectPromise;
  } finally {
    if (healthClientConnectPromise === connectPromise) {
      healthClientConnectPromise = null;
    }
  }
}

async function discardHealthClient(client: Client, deadlineMs?: number): Promise<void> {
  if (healthClient === client) healthClient = null;
  const existingClose = healthClientClosePromises.get(client);
  const closePromise = existingClose ?? client.end().catch((err) => {
    logger.warn({ err }, "Health check connection cleanup failed");
  });
  if (!existingClose) healthClientClosePromises.set(client, closePromise);
  if (deadlineMs === undefined) return closePromise;

  const remainingMs = deadlineMs - Date.now();
  if (remainingMs <= 0) return;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      closePromise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, remainingMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function finalizeHealthCheckDiagnostics(
  timeoutMs: number,
  startedAt: number,
  timings: MutableHealthCheckTimings,
): HealthCheckDiagnostics {
  return {
    timeout_ms: timeoutMs,
    attempts: timings.attempts,
    connect_ms: timings.connectMs,
    query_ms: timings.queryMs,
    cleanup_ms: timings.cleanupMs,
    total_ms: Date.now() - startedAt,
    pool: getDatabasePoolSnapshot(),
  };
}

function attachHealthCheckDiagnostics(
  error: unknown,
  diagnostics: HealthCheckDiagnostics,
): unknown {
  if (error instanceof Error) {
    Object.defineProperty(error, 'healthCheckDiagnostics', {
      configurable: true,
      value: diagnostics,
    });
  }
  return error;
}

export function getHealthCheckDiagnostics(error: unknown): HealthCheckDiagnostics | undefined {
  return error instanceof Error
    ? (error as HealthCheckError).healthCheckDiagnostics
    : undefined;
}

/**
 * Perform a health check on a reusable connection outside the application
 * pool. Concurrent HTTP probes share one in-flight query. A failed connection
 * is discarded so the next probe establishes a fresh session.
 */
export async function healthCheck(timeoutMs = 5000): Promise<HealthCheckDiagnostics> {
  if (healthCheckPromise) return healthCheckPromise;

  const startedAt = Date.now();
  const deadlineMs = startedAt + timeoutMs;
  const timings: MutableHealthCheckTimings = {
    attempts: 0,
    connectMs: 0,
    queryMs: 0,
    cleanupMs: 0,
  };
  const checkOnce = async (): Promise<void> => {
    timings.attempts++;
    if (deadlineMs - Date.now() <= 0) throw healthTimeout('health check query timed out');

    const client = await getHealthClient(deadlineMs, timings);
    const queryStartedAt = Date.now();

    try {
      await healthOperationBeforeDeadline(
        () => client.query('SELECT 1'),
        deadlineMs,
        'health check query timed out',
      );
    } catch (error) {
      timings.queryMs += Date.now() - queryStartedAt;
      const cleanupStartedAt = Date.now();
      await discardHealthClient(client, deadlineMs);
      timings.cleanupMs += Date.now() - cleanupStartedAt;
      throw error;
    }
    timings.queryMs += Date.now() - queryStartedAt;
  };

  const run = async (): Promise<HealthCheckDiagnostics> => {
    try {
      await checkOnce();
    } catch (error) {
      if (!isTransientConnectionError(error) || Date.now() >= deadlineMs) {
        throw attachHealthCheckDiagnostics(
          error,
          finalizeHealthCheckDiagnostics(timeoutMs, startedAt, timings),
        );
      }
      logger.warn(
        { err: error, pool: getDatabasePoolSnapshot() },
        'Transient health check connection error; retrying once',
      );
      try {
        await checkOnce();
      } catch (retryError) {
        throw attachHealthCheckDiagnostics(
          retryError,
          finalizeHealthCheckDiagnostics(timeoutMs, startedAt, timings),
        );
      }
    }
    return finalizeHealthCheckDiagnostics(timeoutMs, startedAt, timings);
  };

  const checkPromise = run();
  healthCheckPromise = checkPromise;

  try {
    return await checkPromise;
  } finally {
    if (healthCheckPromise === checkPromise) healthCheckPromise = null;
  }
}

/**
 * Close database connection pool
 */
export async function closeDatabase(): Promise<void> {
  if (pool) {
    if (healthCheckPromise) await healthCheckPromise.catch(() => undefined);
    const client = healthClient;
    healthClient = null;
    healthClientConnectPromise = null;
    healthCheckPromise = null;
    if (client) await discardHealthClient(client);
    await pool.end();
    pool = null;
    poolConfig = null;
    console.log("Database connection pool closed");
  }
}

/**
 * Check if database is initialized
 */
export function isDatabaseInitialized(): boolean {
  return pool !== null;
}

/** Escape SQL LIKE pattern metacharacters (\\, %, _) in a single pass. */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}
