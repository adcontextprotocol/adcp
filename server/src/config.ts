/**
 * Database configuration from environment
 */
export interface DatabaseConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  ssl?: boolean | { rejectUnauthorized: boolean };
  maxPoolSize?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
}

/**
 * Get database configuration from environment variables
 */
export function getDatabaseConfig(): DatabaseConfig | null {
  const connectionString =
    process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL;

  if (!connectionString) {
    return null;
  }

  // SSL configuration
  let ssl: boolean | { rejectUnauthorized: boolean } = false;
  if (process.env.DATABASE_SSL === "true") {
    // Allow explicit control via DATABASE_SSL_REJECT_UNAUTHORIZED
    const rejectUnauthorized =
      process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false";
    ssl = { rejectUnauthorized };
  }

  return {
    connectionString,
    ssl,
      // PgBouncer owns connection pooling. These are intentionally low and
    // NOT configurable via env vars — overriding them re-introduces a
    // second pool that conflicts with PgBouncer's idle timeouts.
    maxPoolSize: 3,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 1000,
  };
}
