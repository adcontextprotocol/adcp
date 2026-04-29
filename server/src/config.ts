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
  minPoolSize?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: "${raw}" (must be a non-negative integer)`);
  }
  return parsed;
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
    maxPoolSize: envInt("DATABASE_POOL_MAX", 8),
    minPoolSize: envInt("DATABASE_POOL_MIN", 0),
    connectionTimeoutMillis: envInt("DATABASE_CONNECTION_TIMEOUT_MS", 5000),
    idleTimeoutMillis: envInt("DATABASE_IDLE_TIMEOUT_MS", 30000),
  };
}
