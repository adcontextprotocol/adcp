import { Client, Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { DatabaseConfig } from "../config.js";
import { createLogger } from "../logger.js";

const logger = createLogger("db");

const SLOW_QUERY_THRESHOLD_MS = 500;

let pool: Pool | null = null;
let poolConfig: DatabaseConfig | null = null;

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
