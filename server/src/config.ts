import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Get the registry root path based on environment
 * In dev: __dirname is /server/src, registry is at ../../registry
 * In prod: __dirname is /dist, registry is at ../registry
 */
export function getRegistryPath(): string {
  return process.env.NODE_ENV === "production"
    ? path.join(__dirname, "../registry")
    : path.join(__dirname, "../../registry");
}

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
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
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
    maxPoolSize: process.env.DATABASE_MAX_POOL_SIZE
      ? parseInt(process.env.DATABASE_MAX_POOL_SIZE, 10)
      : 20,
    idleTimeoutMillis: process.env.DATABASE_IDLE_TIMEOUT_MS
      ? parseInt(process.env.DATABASE_IDLE_TIMEOUT_MS, 10)
      : 30000,
    connectionTimeoutMillis: process.env.DATABASE_CONNECTION_TIMEOUT_MS
      ? parseInt(process.env.DATABASE_CONNECTION_TIMEOUT_MS, 10)
      : 5000,
  };
}
