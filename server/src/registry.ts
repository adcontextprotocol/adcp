import { RegistryDatabase } from "./db/registry-db.js";
import { initializeDatabase } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { getDatabaseConfig } from "./config.js";
import type { Agent, AgentType } from "./types.js";

/**
 * Database-backed registry for AdCP agents
 * Requires DATABASE_URL environment variable to be set
 */
export class Registry {
  private dbRegistry: RegistryDatabase;

  constructor() {
    this.dbRegistry = new RegistryDatabase();
  }

  /**
   * Initialize the registry - requires database configuration
   */
  async initialize(): Promise<void> {
    const dbConfig = getDatabaseConfig();

    if (!dbConfig) {
      throw new Error(
        "DATABASE_URL or DATABASE_PRIVATE_URL environment variable is required. " +
        "The registry is now database-only. To migrate from files, run: npm run db:seed"
      );
    }

    console.log("Initializing database-backed registry...");

    // Initialize database connection
    initializeDatabase(dbConfig);

    // Run migrations
    await runMigrations();

    console.log("✓ Database-backed registry initialized");
  }

  /**
   * List agents
   */
  async listAgents(type?: AgentType): Promise<Agent[]> {
    return this.dbRegistry.listAgents(type);
  }

  /**
   * Get agent by name/slug
   */
  async getAgent(name: string): Promise<Agent | undefined> {
    return this.dbRegistry.getAgent(name);
  }

  /**
   * Get all agents as a map (for compatibility)
   */
  async getAllAgents(): Promise<Map<string, Agent>> {
    const agents = await this.dbRegistry.listAgents();
    const map = new Map<string, Agent>();
    agents.forEach((agent) => {
      // Get slug from metadata (stored during seed) or generate it
      const slug = (agent as any).slug || this.generateSlug(agent);
      map.set(slug, agent);
    });
    return map;
  }

  /**
   * Generate consistent slug from agent data
   */
  private generateSlug(agent: Agent): string {
    // Use type and a slugified version of the name
    const slugName = agent.name.toLowerCase().replace(/\s+/g, "-");
    return `${agent.type}/${slugName}`;
  }

  /**
   * Get database registry instance for direct access
   */
  getDatabaseRegistry(): RegistryDatabase {
    return this.dbRegistry;
  }
}
