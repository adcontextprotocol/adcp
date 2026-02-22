import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { DatabaseConfig } from "../config.js";

let pool: Pool | null = null;

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
    max: config.maxPoolSize || 20,
    idleTimeoutMillis: config.idleTimeoutMillis || 30000,
    connectionTimeoutMillis: config.connectionTimeoutMillis || 5000,
  });

  // Ensure every connection uses UTF-8 encoding regardless of server defaults
  pool.on("connect", (client) => {
    client.query("SET client_encoding = 'UTF8'").catch((err) => {
      console.error("Failed to set client_encoding on new connection:", err);
    });
  });

  pool.on("error", (err) => {
    console.error("Unexpected database pool error:", err);
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
 * Execute a query
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
