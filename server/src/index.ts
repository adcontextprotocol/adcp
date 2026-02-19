import 'dotenv/config';
import { HTTPServer } from "./http.js";
import { validateEnvironment } from "./env-validation.js";
import { runMigrations } from "./db/migrate.js";
import { getDatabaseConfig } from "./config.js";
import { initializeAddieBolt } from "./addie/index.js";

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

  // Start HTTP server first, then initialize Addie in the background.
  // initializeAddieBolt uses execSync (git clone) which blocks the event loop,
  // so it must not run before the server starts listening.
  const httpServer = new HTTPServer();
  const port = parseInt(process.env.PORT || process.env.CONDUCTOR_PORT || "3000", 10);
  await httpServer.start(port);

  // Addie (AAO Community Agent) with Bolt SDK — initialized after server is running.
  // The router is stored in the Bolt app and retrieved via getAddieBoltRouter().
  initializeAddieBolt().then((result) => {
    if (result) {
      console.log('Addie Bolt initialized successfully');
    }
  }).catch((error) => {
    console.warn('Addie Bolt initialization failed (non-fatal):', error);
  });
}

main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
