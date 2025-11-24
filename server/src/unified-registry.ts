import { Registry } from "./registry.js";
import { RegistryDatabase } from "./db/registry-db.js";
import { initializeDatabase, isDatabaseInitialized } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { getDatabaseConfig } from "./config.js";
import type { Agent, AgentType } from "./types.js";

export type RegistryMode = "database" | "file";

export interface RegistryInitializationError {
  type: "connection" | "migration" | "unknown";
  message: string;
  originalError: Error;
}

/**
 * Unified registry that supports both file-based and database-backed storage
 * Automatically falls back to file-based if database is not available
 */
export class UnifiedRegistry {
  private fileRegistry: Registry;
  private dbRegistry: RegistryDatabase | null = null;
  private mode: RegistryMode = "file";
  private initializationError: RegistryInitializationError | null = null;

  constructor() {
    this.fileRegistry = new Registry();
    this.dbRegistry = null;
  }

  /**
   * Initialize the registry - tries database first, falls back to file-based
   */
  async initialize(): Promise<void> {
    const dbConfig = getDatabaseConfig();

    if (dbConfig) {
      try {
        console.log("Initializing database-backed registry...");

        // Initialize database connection
        initializeDatabase(dbConfig);

        // Run migrations
        await runMigrations();

        // Create database registry
        this.dbRegistry = new RegistryDatabase();
        this.mode = "database";

        console.log("✓ Using database-backed registry");
        return;
      } catch (error) {
        // Categorize error type for better diagnostics
        const errorType = this.categorizeError(error);
        this.initializationError = {
          type: errorType,
          message: error instanceof Error ? error.message : String(error),
          originalError: error instanceof Error ? error : new Error(String(error)),
        };

        console.error(`Failed to initialize database registry (${errorType}):`, error);
        console.log("Falling back to file-based registry");
        this.mode = "file";
      }
    } else {
      console.log("No DATABASE_URL found, using file-based registry");
    }

    // Fall back to file-based registry
    await this.fileRegistry.load();
    console.log("✓ Using file-based registry");
  }

  /**
   * Categorize database initialization errors
   */
  private categorizeError(error: unknown): "connection" | "migration" | "unknown" {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      if (
        message.includes("connect") ||
        message.includes("econnrefused") ||
        message.includes("timeout")
      ) {
        return "connection";
      }
      if (message.includes("migration") || message.includes("schema")) {
        return "migration";
      }
    }
    return "unknown";
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
   * Get initialization error if any
   */
  getInitializationError(): RegistryInitializationError | null {
    return this.initializationError;
  }

  /**
   * Get database registry instance (if available)
   */
  getDatabaseRegistry(): RegistryDatabase | null {
    return this.dbRegistry;
  }
}
