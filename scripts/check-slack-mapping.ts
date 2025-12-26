#!/usr/bin/env npx tsx
/**
 * Check Slack mapping status for debugging
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

async function main() {
  const { initializeDatabase } = await import('../server/src/db/client.js');
  const { SlackDatabase } = await import('../server/src/db/slack-db.js');

  // Initialize database with connection string from env
  initializeDatabase({
    connectionString: process.env.DATABASE_URL!,
  });
  const db = new SlackDatabase();

  // Get stats
  console.log('=== Slack Mapping Stats ===\n');
  const stats = await db.getStats();
  console.log('Total Slack users:', stats.total);
  console.log('Mapped to AAO:', stats.mapped);
  console.log('Unmapped:', stats.unmapped);
  console.log('Bots:', stats.bots);
  console.log('Deleted:', stats.deleted);
  console.log('Opted out:', stats.opted_out);

  // Search for specific user by getting all and filtering
  const searchTerm = process.argv[2] || 'bokelley';
  console.log(`\n=== Search for "${searchTerm}" ===\n`);

  const allMappings = await db.getAllMappings({ limit: 5000 });
  const results = allMappings.filter(m =>
    (m.slack_real_name && m.slack_real_name.toLowerCase().includes(searchTerm.toLowerCase())) ||
    (m.slack_display_name && m.slack_display_name.toLowerCase().includes(searchTerm.toLowerCase())) ||
    (m.slack_email && m.slack_email.toLowerCase().includes(searchTerm.toLowerCase()))
  );

  if (results.length === 0) {
    console.log('No results found');
  } else {
    results.forEach(m => {
      console.log(`Slack User ID: ${m.slack_user_id}`);
      console.log(`  Name: ${m.slack_real_name || m.slack_display_name || '(no name)'}`);
      console.log(`  Email: ${m.slack_email || '(no email)'}`);
      console.log(`  WorkOS User ID: ${m.workos_user_id || '(NOT LINKED)'}`);
      console.log(`  Mapping Status: ${m.mapping_status}`);
      console.log(`  Mapping Source: ${m.mapping_source || '(none)'}`);
      console.log(`  Is Bot: ${m.slack_is_bot}`);
      console.log(`  Is Deleted: ${m.slack_is_deleted}`);
      console.log('');
    });
  }

  // Show first few mapped users
  console.log('\n=== Sample Mapped Users ===\n');
  const mapped = await db.getAllMappings({ onlyMapped: true, limit: 5 });
  if (mapped.length === 0) {
    console.log('No mapped users found - run a sync first!');
  } else {
    mapped.forEach(m => {
      console.log(`${m.slack_real_name} <${m.slack_email}> -> ${m.workos_user_id}`);
    });
  }
}

main().then(async () => {
  const { closeDatabase } = await import('../server/src/db/client.js');
  await closeDatabase();
  process.exit(0);
}).catch(async err => {
  console.error('Error:', err);
  const { closeDatabase } = await import('../server/src/db/client.js');
  await closeDatabase();
  process.exit(1);
});
