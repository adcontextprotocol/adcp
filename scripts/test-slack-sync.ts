#!/usr/bin/env npx tsx
/**
 * Test script for Slack user sync
 *
 * Usage: npx tsx scripts/test-slack-sync.ts
 *
 * Requires SLACK_BOT_TOKEN in .env.local
 */

import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env.local from project root
dotenv.config({ path: path.join(__dirname, '..', '.env.local') });

async function main() {
  console.log('🔍 Testing Slack Integration\n');

  // Dynamic import after env is loaded
  const { testSlackConnection, getSlackUsers, isSlackConfigured } = await import('../server/src/slack/client.js');

  // Check if configured
  if (!isSlackConfigured()) {
    console.log('❌ SLACK_BOT_TOKEN is not set in environment');
    console.log('   Add it to .env.local and try again');
    process.exit(1);
  }

  console.log('✅ SLACK_BOT_TOKEN is configured\n');

  // Test connection
  console.log('🔗 Testing Slack connection...');
  const connection = await testSlackConnection();

  if (!connection.ok) {
    console.log(`❌ Connection failed: ${connection.error}`);
    process.exit(1);
  }

  console.log(`✅ Connected to workspace: ${connection.team}`);
  console.log(`   Bot user: ${connection.user} (${connection.user_id})`);
  console.log(`   Bot ID: ${connection.bot_id}\n`);

  // Fetch users
  console.log('👥 Fetching Slack users...');
  const users = await getSlackUsers();

  const realUsers = users.filter(u => !u.is_bot && !u.deleted);
  const bots = users.filter(u => u.is_bot);
  const deleted = users.filter(u => u.deleted);

  console.log(`✅ Found ${users.length} total users:`);
  console.log(`   - ${realUsers.length} active users`);
  console.log(`   - ${bots.length} bots`);
  console.log(`   - ${deleted.length} deleted/deactivated\n`);

  // Show sample of users
  console.log('📋 Sample users (first 10 active):');
  realUsers.slice(0, 10).forEach(user => {
    const email = user.profile?.email || '(no email)';
    const name = user.profile?.real_name || user.name;
    console.log(`   - ${name} <${email}>`);
  });

  if (realUsers.length > 10) {
    console.log(`   ... and ${realUsers.length - 10} more`);
  }

  console.log('\n✅ Slack integration is working!');
  console.log('\nNext steps:');
  console.log('1. Start the server: npm run dev');
  console.log('2. Run migrations: npm run db:migrate (or restart Docker)');
  console.log('3. Call POST /api/admin/slack/sync to sync users to database');
  console.log('4. Call GET /api/admin/slack/unified to see unified user view');
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
