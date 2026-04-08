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
    max: config.maxPoolSize || 10,
    idleTimeoutMillis: config.idleTimeoutMillis || 10000,
    connectionTimeoutMillis: config.connectionTimeoutMillis || 5000,
    // Detect dead connections killed by managed Postgres providers (Neon, Supabase)
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  });

  // Kill queries that run longer than 30s to prevent connection hoarding.
  // Set per-connection (not via startup `options`) for PgBouncer compatibility.
  // Note: pg's "connect" event doesn't support async callbacks, so there's a
  // theoretical race where a query could run before SET completes. In practice
  // the SET finishes in <1ms on a freshly established connection. For belt-and-
  // suspenders, also set `ALTER ROLE ... SET statement_timeout = 30000` in Postgres.
  pool.on("connect", (client) => {
    client.query("SET statement_timeout = 30000").catch((err) => {
      console.error("Failed to set statement_timeout on connection:", err);
    });
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
