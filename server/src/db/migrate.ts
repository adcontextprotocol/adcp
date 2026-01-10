import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { getPool, initializeDatabase } from "./client.js";
import { DatabaseConfig } from "../config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface Migration {
  filename: string;
  version: number;
  sql: string;
}

/**
 * Migration filename format: NNN_description.sql
 * Example: 001_initial.sql, 002_add_indexes.sql
 */
const MIGRATION_FILENAME_PATTERN = /^(\d+)_(.+)\.sql$/;

/**
 * Parse and validate migration filename
 */
function parseMigrationFilename(filename: string): { version: number; description: string } | null {
  const match = filename.match(MIGRATION_FILENAME_PATTERN);
  if (!match) {
    return null;
  }

  const version = parseInt(match[1], 10);
  if (isNaN(version)) {
    return null;
  }

  return {
    version,
    description: match[2],
  };
}

/**
 * Load all migration files
 */
async function loadMigrations(): Promise<Migration[]> {
  const migrationsDir = path.join(__dirname, "migrations");
  const files = await fs.readdir(migrationsDir);

  const migrations: Migration[] = [];
  const errors: string[] = [];

  for (const file of files) {
    if (file.endsWith(".sql")) {
      const parsed = parseMigrationFilename(file);

      if (!parsed) {
        errors.push(
          `Invalid migration filename: ${file}. Expected format: NNN_description.sql (e.g., 001_initial.sql)`
        );
        continue;
      }

      const filePath = path.join(migrationsDir, file);
      const sql = await fs.readFile(filePath, "utf-8");

      migrations.push({
        filename: file,
        version: parsed.version,
        sql,
      });
    }
  }

  if (errors.length > 0) {
    throw new Error(`Migration filename validation failed:\n${errors.join("\n")}`);
  }

  return migrations.sort((a, b) => a.version - b.version);
}

/**
 * Create migrations tracking table
 */
async function createMigrationsTable(): Promise<void> {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      filename VARCHAR(255) NOT NULL,
      applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
    );
  `);
}

/**
 * Get list of applied migrations
 */
async function getAppliedMigrations(): Promise<number[]> {
  const pool = getPool();

  const result = await pool.query<{ version: number }>(
    "SELECT version FROM schema_migrations ORDER BY version"
  );

  return result.rows.map((row) => row.version);
}

/**
 * Apply a single migration
 */
async function applyMigration(migration: Migration): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    // Execute migration SQL
    await client.query(migration.sql);

    // Record migration
    await client.query(
      "INSERT INTO schema_migrations (version, filename) VALUES ($1, $2)",
      [migration.version, migration.filename]
    );

    await client.query("COMMIT");

    console.log(`✓ Applied migration: ${migration.filename}`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error(`✗ Failed to apply migration: ${migration.filename}`);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Run all pending migrations
 */
export async function runMigrations(config?: DatabaseConfig): Promise<void> {
  // Initialize database if config provided
  if (config) {
    initializeDatabase(config);
  }

  // Create migrations table
  await createMigrationsTable();

  // Load all migrations
  const migrations = await loadMigrations();
  const appliedVersions = await getAppliedMigrations();

  // Find pending migrations
  const pendingMigrations = migrations.filter(
    (m) => !appliedVersions.includes(m.version)
  );

  if (pendingMigrations.length === 0) {
    // Quiet startup - no output when nothing to do
    return;
  }

  console.log(`Applying ${pendingMigrations.length} pending migrations...`);

  // Apply each pending migration
  for (const migration of pendingMigrations) {
    await applyMigration(migration);
  }

  console.log("✓ All migrations completed successfully");
}

/**
 * CLI runner for migrations
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  // SSL configuration - matches config.ts pattern
  let ssl: boolean | { rejectUnauthorized: boolean } = false;
  if (process.env.DATABASE_SSL === "true") {
    // Allow explicit control via DATABASE_SSL_REJECT_UNAUTHORIZED
    const rejectUnauthorized =
      process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "false";
    ssl = { rejectUnauthorized };
  }

  const config: DatabaseConfig = {
    connectionString:
      process.env.DATABASE_URL || process.env.DATABASE_PRIVATE_URL,
    ssl,
  };

  runMigrations(config)
    .then(() => {
      console.log("Migration complete");
      process.exit(0);
    })
    .catch((error) => {
      console.error("Migration failed:", error);
      process.exit(1);
    });
}
