/**
 * Test the buildSystemPrompt function from the database
 */

import { initializeDatabase, closeDatabase } from '../server/src/db/client.js';
import { AddieDatabase } from '../server/src/db/addie-db.js';

async function main() {
  const config = {
    connectionString: process.env.DATABASE_URL,
    ssl: false,
  };

  initializeDatabase(config);
  const db = new AddieDatabase();

  console.log('='.repeat(80));
  console.log('ACTIVE RULES FROM DATABASE');
  console.log('='.repeat(80));

  const rules = await db.getActiveRules();
  console.log(`Found ${rules.length} active rules:\n`);

  for (const rule of rules) {
    console.log(`  [${rule.id}] ${rule.rule_type.toUpperCase()}: ${rule.name} (priority: ${rule.priority})`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('COMPILED SYSTEM PROMPT');
  console.log('='.repeat(80) + '\n');

  const prompt = await db.buildSystemPrompt();
  console.log(prompt);

  console.log('\n' + '='.repeat(80));

  await closeDatabase();
}

main().catch(console.error);
