import { Registry } from "./registry.js";
import { RegistryDatabase } from "./db/registry-db.js";
import { initializeDatabase, isDatabaseInitialized } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { getDatabaseConfig } from "./config.js";
import type { Agent, AgentType } from "./types.js";

export type RegistryMode = "database" | "file";

/**
 * Unified registry that supports both file-based and database-backed storage
 * Mode is determined at startup based on DATABASE_URL presence (no fallback)
 */
export class UnifiedRegistry {
  private fileRegistry: Registry;
  private dbRegistry: RegistryDatabase | null = null;
  private mode: RegistryMode = "file";

  constructor() {
    this.fileRegistry = new Registry();
    this.dbRegistry = null;
  }

  /**
   * Initialize the registry - database mode or file mode (no fallback)
   */
  async initialize(): Promise<void> {
    const dbConfig = getDatabaseConfig();

    if (dbConfig) {
      // Database mode - fail if database doesn't work
      console.log("Initializing database-backed registry...");

      // Initialize database connection
      initializeDatabase(dbConfig);

      // Run migrations
      await runMigrations();

      // Create database registry
      this.dbRegistry = new RegistryDatabase();
      this.mode = "database";

      console.log("✓ Using database-backed registry");
    } else {
      // File mode - only when no DATABASE_URL configured
      console.log("No DATABASE_URL found, using file-based registry");
      await this.fileRegistry.load();
      this.mode = "file";
      console.log("✓ Using file-based registry");
    }
  }

  /**
   * List agents
   */
  async listAgents(type?: AgentType): Promise<Agent[]> {
    if (this.mode === "database" && this.dbRegistry) {
      return this.dbRegistry.listAgents(type);
    }
    return this.fileRegistry.listAgents(type);
  }

  /**
   * Get agent by name/slug
   */
  async getAgent(name: string): Promise<Agent | undefined> {
    if (this.mode === "database" && this.dbRegistry) {
      return this.dbRegistry.getAgent(name);
    }
    return this.fileRegistry.getAgent(name);
  }

  /**
   * Get all agents as a map (for compatibility)
   */
  async getAllAgents(): Promise<Map<string, Agent>> {
    if (this.mode === "database" && this.dbRegistry) {
      const agents = await this.dbRegistry.listAgents();
      const map = new Map<string, Agent>();
      agents.forEach((agent) => {
        // Get slug from metadata (stored during seed) or generate it
        const slug = (agent as any).slug || this.generateSlug(agent);
        map.set(slug, agent);
      });
      return map;
    }
    return this.fileRegistry.getAllAgents();
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
   * Get current registry mode
   */
  getMode(): RegistryMode {
    return this.mode;
  }

  /**
   * Check if using database
   */
  isUsingDatabase(): boolean {
    return this.mode === "database";
  }

  /**
   * Get database registry instance (if available)
   */
  getDatabaseRegistry(): RegistryDatabase | null {
    return this.dbRegistry;
  }
}
