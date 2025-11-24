import fs from "fs/promises";
import path from "path";
import { initializeDatabase, getClient } from "./client.js";
import { runMigrations } from "./migrate.js";
import { RegistryDatabase } from "./registry-db.js";
import { getRegistryPath, getDatabaseConfig, DatabaseConfig } from "../config.js";
import type { Agent, AgentType } from "../types.js";

const REGISTRY_ROOT = getRegistryPath();

export interface SeedOptions {
  force?: boolean; // Update existing entries
  clean?: boolean; // Clear database before seeding
}

/**
 * Load agents from JSON files
 */
async function loadAgentsFromFiles(): Promise<Map<string, Agent>> {
  const types: AgentType[] = ["creative", "signals", "sales"];
  const agents = new Map<string, Agent>();

  for (const type of types) {
    const dir = path.join(REGISTRY_ROOT, type);
    try {
      const files = await fs.readdir(dir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          const filePath = path.join(dir, file);
          const content = await fs.readFile(filePath, "utf-8");
          const agent: Agent = JSON.parse(content);
          const key = `${type}/${file.replace(".json", "")}`;
          agents.set(key, agent);
        }
      }
    } catch (error) {
      console.error(`Error loading ${type} agents:`, error);
    }
  }

  return agents;
}

/**
 * Convert agent to database entry format
 */
function agentToEntry(agent: Agent, key: string) {
  const slug = key; // Use the file-based key as slug (e.g., "creative/adcp-creative-agent")

  return {
    entry_type: "agent" as const, // All agents have entry_type "agent", type is stored in tags/metadata
    name: agent.name,
    slug: slug,
    url: agent.url,
    metadata: {
      protocol: agent.protocol,
      description: agent.description,
      mcp_endpoint: agent.mcp_endpoint,
      added_date: agent.added_date,
      agent_type: agent.type, // Store the specific agent type (creative/sales/signals)
    },
    tags: [agent.type, agent.protocol || "mcp"],
    contact_name: agent.contact?.name,
    contact_email: agent.contact?.email,
    contact_website: agent.contact?.website,
    approval_status: "approved" as const,
  };
}

/**
 * Seed the database with agents from JSON files
 */
async function seedDatabase(config: DatabaseConfig, options: SeedOptions = {}): Promise<void> {
  console.log("=== Seeding Registry Database ===\n");

  // Initialize database
  initializeDatabase(config);
  console.log("✓ Database connection initialized");

  // Run migrations
  await runMigrations();
  console.log("✓ Migrations complete\n");

  // Load agents from files
  console.log("Loading agents from JSON files...");
  const agents = await loadAgentsFromFiles();
  console.log(`✓ Loaded ${agents.size} agents\n`);

  // Get database client for transaction
  const client = await getClient();

  try {
    await client.query("BEGIN");
    console.log("Starting transaction...\n");

    // Clean database if requested
    if (options.clean) {
      console.log("Cleaning existing entries...");
      await client.query("DELETE FROM registry_entries WHERE entry_type = 'agent'");
      console.log("✓ Database cleaned\n");
    }

    // Insert or update agents
    console.log("Inserting agents into database...");
    let inserted = 0;
    let updated = 0;
    let skipped = 0;

    for (const [key, agent] of agents.entries()) {
      const entry = agentToEntry(agent, key);

      try {
        // Check if entry already exists
        const existingResult = await client.query(
          "SELECT id FROM registry_entries WHERE slug = $1",
          [entry.slug]
        );

        if (existingResult.rows.length > 0) {
          if (options.force) {
            // Update existing entry
            await client.query(
              `UPDATE registry_entries
               SET name = $1, url = $2, metadata = $3, tags = $4,
                   contact_name = $5, contact_email = $6, contact_website = $7
               WHERE slug = $8`,
              [
                entry.name,
                entry.url,
                JSON.stringify(entry.metadata),
                entry.tags,
                entry.contact_name,
                entry.contact_email,
                entry.contact_website,
                entry.slug,
              ]
            );
            console.log(`  ✓ Updated ${entry.name} [${entry.slug}]`);
            updated++;
          } else {
            console.log(`  ⊘ Skipping ${entry.name} (already exists)`);
            skipped++;
          }
        } else {
          // Insert new entry
          await client.query(
            `INSERT INTO registry_entries
             (entry_type, name, slug, url, metadata, tags,
              contact_name, contact_email, contact_website, approval_status)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              entry.entry_type,
              entry.name,
              entry.slug,
              entry.url,
              JSON.stringify(entry.metadata),
              entry.tags,
              entry.contact_name,
              entry.contact_email,
              entry.contact_website,
              entry.approval_status,
            ]
          );
          console.log(`  ✓ Inserted ${entry.name} [${entry.slug}]`);
          inserted++;
        }
      } catch (error: any) {
        console.error(`  ✗ Failed to process ${entry.name}:`, error.message);
        throw error; // Re-throw to rollback transaction
      }
    }

    await client.query("COMMIT");
    console.log("\n✓ Transaction committed");

    console.log(`\n=== Seed Complete ===`);
    console.log(`Inserted: ${inserted}`);
    console.log(`Updated: ${updated}`);
    console.log(`Skipped: ${skipped}`);
    console.log(`Total: ${agents.size}`);
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("\n✗ Transaction rolled back due to error");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * CLI runner for seeding
 * Usage:
 *   npm run db:seed              - Seed database (skip existing)
 *   npm run db:seed -- --force   - Seed database (update existing)
 *   npm run db:seed -- --clean   - Clear and reseed database
 */
if (import.meta.url === `file://${process.argv[1]}`) {
  const config = getDatabaseConfig();

  if (!config) {
    console.error("Error: DATABASE_URL or DATABASE_PRIVATE_URL environment variable is required");
    process.exit(1);
  }

  // Parse CLI arguments
  const args = process.argv.slice(2);
  const options: SeedOptions = {
    force: args.includes("--force"),
    clean: args.includes("--clean"),
  };

  if (options.force) {
    console.log("Mode: Force update (will update existing entries)\n");
  } else if (options.clean) {
    console.log("Mode: Clean seed (will clear existing entries)\n");
  } else {
    console.log("Mode: Safe seed (will skip existing entries)\n");
  }

  seedDatabase(config, options)
    .then(() => {
      console.log("\n✓ Seeding successful");
      process.exit(0);
    })
    .catch((error) => {
      console.error("\n✗ Seeding failed:", error);
      process.exit(1);
    });
}

export { seedDatabase };
