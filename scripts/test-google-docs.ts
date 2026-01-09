#!/usr/bin/env npx tsx
/**
 * Quick test script for Google Docs integration
 *
 * Usage:
 *   npx tsx scripts/test-google-docs.ts <google-doc-url>
 *
 * Requires GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN env vars
 */

import { createGoogleDocsToolHandlers, isGoogleDocsUrl } from '../server/src/addie/mcp/google-docs.js';

// Load env from .env.local
import { config } from 'dotenv';
config({ path: '.env.local' });

async function main() {
  const url = process.argv[2] || 'https://docs.google.com/document/d/1osokTr5Xk2PyLBUHbx2jpPad0TLrQIDh2I6ZWzpHMmY/edit?tab=t.0';

  console.log('\n🔍 Testing Google Docs Integration\n');
  console.log(`URL: ${url}`);
  console.log(`Is Google Docs URL: ${isGoogleDocsUrl(url)}\n`);

  // Check env vars
  const hasClientId = !!process.env.GOOGLE_CLIENT_ID;
  const hasClientSecret = !!process.env.GOOGLE_CLIENT_SECRET;
  const hasRefreshToken = !!process.env.GOOGLE_REFRESH_TOKEN;

  console.log('Environment check:');
  console.log(`  GOOGLE_CLIENT_ID: ${hasClientId ? '✓ set' : '✗ missing'}`);
  console.log(`  GOOGLE_CLIENT_SECRET: ${hasClientSecret ? '✓ set' : '✗ missing'}`);
  console.log(`  GOOGLE_REFRESH_TOKEN: ${hasRefreshToken ? '✓ set' : '✗ missing'}\n`);

  const handlers = createGoogleDocsToolHandlers();

  if (!handlers) {
    console.error('❌ Google Docs tools not available - missing credentials');
    process.exit(1);
  }

  console.log('📄 Fetching document...\n');

  try {
    const result = await handlers.read_google_doc({ url });
    console.log('Result:');
    console.log('─'.repeat(60));
    console.log(result);
    console.log('─'.repeat(60));
    console.log('\n✅ Test complete!');
  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();
