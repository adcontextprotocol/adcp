import 'dotenv/config';
import { MCPServer } from "./mcp.js";
import { HTTPServer } from "./http.js";
import { validateEnvironment } from "./env-validation.js";
import { runMigrations } from "./db/migrate.js";
import { getDatabaseConfig } from "./config.js";

// Validate environment variables before starting server
validateEnvironment();

async function main() {
  // Run migrations on startup if RUN_MIGRATIONS is set
  if (process.env.RUN_MIGRATIONS === 'true') {
    console.log('RUN_MIGRATIONS=true, running database migrations...');
    try {
      const dbConfig = getDatabaseConfig();
      if (!dbConfig) {
        throw new Error('DATABASE_URL not configured');
      }
      await runMigrations(dbConfig);
    } catch (error) {
      console.error('Migration failed:', error);
      process.exit(1);
    }
  }

  // Check if running as MCP server (stdio) or HTTP server
  const mode = process.env.MODE || "http";

  if (mode === "mcp") {
    const mcpServer = new MCPServer();
    await mcpServer.start();
  } else {
    const httpServer = new HTTPServer();
    const port = parseInt(process.env.PORT || process.env.CONDUCTOR_PORT || "3000", 10);
    await httpServer.start(port);
  }
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
