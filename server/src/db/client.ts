import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { DatabaseConfig } from "../config.js";

let pool: Pool | null = null;

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

  pool = new Pool({
    connectionString: config.connectionString,
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl,
    // PgBouncer handles connection pooling on the server side, but we still
    // keep connections alive in the local pool to avoid connection churn.
    // Previously idleTimeoutMillis was 1ms which forced a new PgBouncer
    // connection for every query — hammering PgBouncer under load.
    max: config.maxPoolSize || 10,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30000,
    connectionTimeoutMillis: config.connectionTimeoutMillis || 10000,
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

/**
 * Execute a parameterized query. All callers must use $1, $2, etc. placeholders
 * with the params array -- never concatenate user input into the text argument.
 */
export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  const pool = getPool();
  return pool.query<T>(text, params);
}

/**
 * Get a client from the pool for transactions
 */
export async function getClient(): Promise<PoolClient> {
  const pool = getPool();
  return pool.connect();
}

/**
 * Perform a health check using the pool.
 *
 * Previous versions opened a dedicated pg.Client on every call, bypassing
 * the pool. Under load this added connection churn (TCP + TLS handshake
 * every 15 s per machine) and competed with real traffic for PgBouncer
 * slots — causing the very timeouts it was trying to avoid.
 *
 * Using the pool is the correct signal: if the pool cannot serve a trivial
 * query within the timeout, the machine genuinely cannot handle DB traffic
 * and Fly should stop routing to it.
 */
export async function healthCheck(timeoutMs = 5000): Promise<void> {
  const p = getPool();
  const result = await Promise.race([
    p.query('SELECT 1'),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('health check query timed out')), timeoutMs)
    ),
  ]);
  return result as unknown as void;
}

/**
 * Close database connection pool
 */
export async function closeDatabase(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
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
