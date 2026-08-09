import { Client, Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { DatabaseConfig } from "../config.js";
import { createLogger } from "../logger.js";

const logger = createLogger("db");

const SLOW_QUERY_THRESHOLD_MS = 500;

let pool: Pool | null = null;
let poolConfig: DatabaseConfig | null = null;
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
  "timeout exceeded when trying to connect",
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
      console.warn("Transient DB connection error, retrying query:", (err as Error).message);
      return p.query<T>(text, params);
    }
    throw err;
  } finally {
    const durationMs = Number(process.hrtime.bigint() - start) / 1e6;
    if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
      logger.warn({ duration_ms: Math.round(durationMs) }, "Slow database query");
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

/**
 * Execute one query with server-enforced statement and lock deadlines.
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
): Promise<QueryResult<T>> {
  const inheritedDeadline = queryDeadline.getStore();
  const deadlineMs = Math.min(
    Date.now() + timeoutMs,
    inheritedDeadline?.deadlineMs ?? Number.POSITIVE_INFINITY,
  );
  const client = await getClient();
  let transactionStarted = false;
  try {
    const effectiveTimeoutMs = deadlineMs - Date.now();
    if (effectiveTimeoutMs <= 0) {
      throw Object.assign(new Error('Database query deadline exceeded'), { code: '57014' });
    }
    await client.query(inheritedDeadline?.readOnly === false ? 'BEGIN' : 'BEGIN READ ONLY');
    transactionStarted = true;
    await client.query("SELECT set_config('statement_timeout', $1, true)", [
      `${effectiveTimeoutMs}ms`,
    ]);
    await client.query("SELECT set_config('lock_timeout', $1, true)", [
      `${Math.min(effectiveTimeoutMs, 2_000)}ms`,
    ]);
    const result = await client.query<T>(text, params);
    await client.query('COMMIT');
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) {
      await client.query('ROLLBACK').catch((rollbackError) => {
        logger.warn({ err: rollbackError }, 'Timed query rollback failed');
      });
    }
    throw error;
  } finally {
    client.release();
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
      console.warn("Transient DB connection error, retrying client checkout:", (err as Error).message);
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
 * Perform a health check using a one-off connection, outside the application
 * pool, so saturated worker traffic does not make a reachable database look
 * down to the load balancer.
 */
export async function healthCheck(timeoutMs = 5000): Promise<void> {
  if (!poolConfig) {
    throw new Error("Database not initialized. Call initializeDatabase() first.");
  }

  const client = new Client({
    connectionString: poolConfig.connectionString,
    host: poolConfig.host,
    port: poolConfig.port,
    database: poolConfig.database,
    user: poolConfig.user,
    password: poolConfig.password,
    ssl: poolConfig.ssl,
    connectionTimeoutMillis: Math.min(poolConfig.connectionTimeoutMillis ?? timeoutMs, timeoutMs),
  });

  let timeout: NodeJS.Timeout | null = null;
  try {
    await client.connect();
    await Promise.race([
      client.query('SELECT 1'),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('health check query timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    await client.end().catch((err) => {
      logger.warn({ err }, "Health check connection cleanup failed");
    });
  }
}

/**
 * Close database connection pool
 */
export async function closeDatabase(): Promise<void> {
  if (pool) {
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
