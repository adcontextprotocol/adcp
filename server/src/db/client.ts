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
    // PgBouncer owns connection pooling — we do NOT pool here.
    // We use pg.Pool only as a connection manager: it gives us pool.query()
    // (atomic connect → query → release) and pool.connect() (checkout/release
    // for transactions). With max: 3 and a 1 s idle timeout, this is just a
    // thin TCP cache — connections are reused briefly within request bursts
    // then closed well before PgBouncer's client_idle_timeout can fire.
    max: config.maxPoolSize || 3,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 1000,
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

/** Transient connection errors that are safe to retry (PgBouncer / TCP resets). */
const TRANSIENT_CONNECTION_ERRORS = new Set([
  "client_idle_timeout",
  "server_login_retry",
  "connection_reset",
  "ECONNRESET",
  "EPIPE",
  "57P01", // admin_shutdown
  "57P03", // cannot_connect_now
  "08006", // connection_failure
  "08003", // connection_does_not_exist
]);

function isTransientConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = (err as any).code || err.message || "";
  return TRANSIENT_CONNECTION_ERRORS.has(msg);
}

/**
 * Execute a parameterized query. All callers must use $1, $2, etc. placeholders
 * with the params array -- never concatenate user input into the text argument.
 *
 * Automatically retries once on transient connection errors (e.g. PgBouncer
 * closing an idle connection between pool checkout and query execution).
 */
export async function query<T extends QueryResultRow = any>(
  text: string,
  params?: any[]
): Promise<QueryResult<T>> {
  const p = getPool();
  try {
    return await p.query<T>(text, params);
  } catch (err) {
    if (isTransientConnectionError(err)) {
      console.warn("Transient DB connection error, retrying query:", (err as Error).message);
      return p.query<T>(text, params);
    }
    throw err;
  }
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
