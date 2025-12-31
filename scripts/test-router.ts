/**
 * Test script for the Addie router
 *
 * Run with: npx tsx scripts/test-router.ts
 *
 * Options:
 *   --live     Use actual Haiku API (requires ANTHROPIC_API_KEY)
 *   --db       Pull real messages from production database
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { AddieRouter, ROUTING_RULES, type RoutingContext, type ExecutionPlan } from '../server/src/addie/router.js';
import type { MemberContext } from '../server/src/addie/member-context.js';

// Sample test scenarios
const TEST_SCENARIOS: Array<{
  name: string;
  context: RoutingContext;
  expectedAction: ExecutionPlan['action'];
  expectedReason?: string;
}> = [
  // === IGNORE cases ===
  {
    name: 'Simple acknowledgment "ok"',
    context: { message: 'ok', source: 'channel' },
    expectedAction: 'ignore',
  },
  {
    name: 'Simple acknowledgment "got it"',
    context: { message: 'got it', source: 'channel' },
    expectedAction: 'ignore',
  },
  {
    name: 'Simple acknowledgment "sounds good"',
    context: { message: 'sounds good', source: 'channel' },
    expectedAction: 'ignore',
  },
  {
    name: 'Casual "lol"',
    context: { message: 'lol', source: 'channel' },
    expectedAction: 'ignore',
  },

  // === REACT cases ===
  {
    name: 'Simple greeting "hi"',
    context: { message: 'hi', source: 'channel' },
    expectedAction: 'react',
  },
  {
    name: 'Simple greeting "hello"',
    context: { message: 'hello', source: 'channel' },
    expectedAction: 'react',
  },
  {
    name: 'Welcome message',
    context: { message: 'welcome to the channel!', source: 'channel' },
    expectedAction: 'react',
  },
  {
    name: 'Thanks message',
    context: { message: 'thanks!', source: 'channel' },
    expectedAction: 'react',
  },

  // === RESPOND cases (AdCP protocol) ===
  {
    name: 'AdCP question',
    context: { message: 'What is AdCP and how does it work?', source: 'mention' },
    expectedAction: 'respond',
  },
  {
    name: 'Protocol schema question',
    context: { message: 'Can you explain the AdCP schema for media buys?', source: 'dm' },
    expectedAction: 'respond',
  },
  {
    name: 'Signals question',
    context: { message: 'How do signals work in the protocol?', source: 'mention' },
    expectedAction: 'respond',
  },

  // === RESPOND cases (Salesagent) ===
  {
    name: 'Salesagent setup question',
    context: { message: 'How do I set up salesagent?', source: 'dm' },
    expectedAction: 'respond',
  },
  {
    name: 'Reference implementation question',
    context: { message: 'Where can I find the open source agent reference implementation?', source: 'mention' },
    expectedAction: 'respond',
  },

  // === RESPOND cases (Client libraries) ===
  {
    name: 'SDK question',
    context: { message: 'Is there a JavaScript SDK for AdCP?', source: 'dm' },
    expectedAction: 'respond',
  },
  {
    name: 'Python client question',
    context: { message: 'How do I use the Python client?', source: 'mention' },
    expectedAction: 'respond',
  },

  // === RESPOND cases (Membership) ===
  {
    name: 'Membership question',
    context: { message: 'How do I join AgenticAdvertising.org?', source: 'dm' },
    expectedAction: 'respond',
  },
  {
    name: 'Working group question',
    context: { message: 'What working groups are available?', source: 'mention' },
    expectedAction: 'respond',
  },
  {
    name: 'Profile question',
    context: { message: 'Can you show me my profile?', source: 'dm' },
    expectedAction: 'respond',
  },

  // === RESPOND cases (External protocols) ===
  {
    name: 'MCP question',
    context: { message: 'How does AdCP compare to MCP?', source: 'mention' },
    expectedAction: 'respond',
  },
  {
    name: 'A2A question',
    context: { message: 'What is the difference between AdCP and agent-to-agent protocol?', source: 'dm' },
    expectedAction: 'respond',
  },

  // === RESPOND cases (adagents.json) ===
  {
    name: 'Agent manifest question',
    context: { message: 'Can you validate my adagents.json file?', source: 'dm' },
    expectedAction: 'respond',
  },

  // === Edge cases ===
  {
    name: 'Greeting with question (should respond, not just react)',
    context: { message: 'Hi! Can you help me understand AdCP?', source: 'mention' },
    expectedAction: 'respond',
  },
  {
    name: 'Off-topic question',
    context: { message: 'What is the weather today?', source: 'channel' },
    expectedAction: 'ignore',
  },
  {
    name: 'Directed at specific person',
    context: { message: '@john can you review this PR?', source: 'channel' },
    expectedAction: 'ignore',
  },
  {
    name: 'Community discussion search',
    context: { message: 'What did people say about the new signals spec?', source: 'mention' },
    expectedAction: 'respond',
  },
  {
    name: 'Industry news',
    context: { message: 'Any news about agentic advertising?', source: 'dm' },
    expectedAction: 'respond',
  },
];

// Mock member context for testing
const MOCK_MEMBER_CONTEXT: MemberContext = {
  slack_user: {
    slack_user_id: 'U123456',
    display_name: 'Test User',
    email: 'test@example.com',
  },
  workos_user: {
    workos_user_id: 'user_123',
    email: 'test@example.com',
    first_name: 'Test',
    last_name: 'User',
  },
  org_membership: {
    organization_id: 'org_123',
    role: 'member',
  },
  working_groups: [],
  is_linked: true,
};

const MOCK_ADMIN_CONTEXT: MemberContext = {
  ...MOCK_MEMBER_CONTEXT,
  org_membership: {
    organization_id: 'org_123',
    role: 'admin',
  },
};

/**
 * Test quickMatch only (no API calls)
 */
function testQuickMatch(): void {
  console.log('\n🔍 Testing quickMatch (no API calls)\n');
  console.log('=' .repeat(60));

  const router = new AddieRouter('fake-key');
  let passed = 0;
  let failed = 0;

  for (const scenario of TEST_SCENARIOS) {
    const result = router.quickMatch(scenario.context);

    if (result) {
      const match = result.action === scenario.expectedAction;
      if (match) {
        console.log(`✅ ${scenario.name}`);
        console.log(`   Message: "${scenario.context.message}"`);
        console.log(`   Result: ${result.action} (${result.reason})`);
        passed++;
      } else {
        console.log(`❌ ${scenario.name}`);
        console.log(`   Message: "${scenario.context.message}"`);
        console.log(`   Expected: ${scenario.expectedAction}`);
        console.log(`   Got: ${result.action} (${result.reason})`);
        failed++;
      }
    } else {
      // No quick match - would need full router
      console.log(`⏭️  ${scenario.name} (no quick match - needs full router)`);
      console.log(`   Message: "${scenario.context.message}"`);
      console.log(`   Expected: ${scenario.expectedAction}`);
    }
    console.log('');
  }

  console.log('=' .repeat(60));
  console.log(`Quick match results: ${passed} passed, ${failed} failed`);
}

/**
 * Test full router with live API
 */
async function testFullRouter(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.log('\n⚠️  ANTHROPIC_API_KEY not set - skipping live router tests');
    return;
  }

  console.log('\n🤖 Testing full router with Haiku\n');
  console.log('=' .repeat(60));

  const router = new AddieRouter(apiKey);
  let passed = 0;
  let failed = 0;
  const results: Array<{ scenario: string; expected: string; actual: string; match: boolean }> = [];

  for (const scenario of TEST_SCENARIOS) {
    // Add mock member context
    const context: RoutingContext = {
      ...scenario.context,
      memberContext: MOCK_MEMBER_CONTEXT,
    };

    try {
      const result = await router.route(context);
      const match = result.action === scenario.expectedAction;

      results.push({
        scenario: scenario.name,
        expected: scenario.expectedAction,
        actual: result.action,
        match,
      });

      if (match) {
        console.log(`✅ ${scenario.name}`);
        passed++;
      } else {
        console.log(`❌ ${scenario.name}`);
        failed++;
      }
      console.log(`   Message: "${scenario.context.message}"`);
      console.log(`   Expected: ${scenario.expectedAction}`);
      console.log(`   Got: ${result.action} (${result.reason})`);

      if (result.action === 'respond' && 'tools' in result) {
        console.log(`   Tools: [${result.tools.join(', ')}]`);
      }
      if (result.action === 'react' && 'emoji' in result) {
        console.log(`   Emoji: :${result.emoji}:`);
      }
      console.log('');

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (error) {
      console.log(`💥 ${scenario.name}`);
      console.log(`   Error: ${error instanceof Error ? error.message : 'Unknown'}`);
      failed++;
    }
  }

  console.log('=' .repeat(60));
  console.log(`Full router results: ${passed} passed, ${failed} failed out of ${TEST_SCENARIOS.length}`);

  // Print summary table
  console.log('\n📊 Summary:\n');
  console.log('| Scenario | Expected | Actual | Match |');
  console.log('|----------|----------|--------|-------|');
  for (const r of results) {
    console.log(`| ${r.scenario.substring(0, 30).padEnd(30)} | ${r.expected.padEnd(8)} | ${r.actual.padEnd(6)} | ${r.match ? '✅' : '❌'}     |`);
  }
}

/**
 * Pull real messages from database and test router on them
 */
async function testWithDatabaseMessages(): Promise<void> {
  console.log('\n📦 Testing with real database messages\n');
  console.log('This feature requires a database connection.');
  console.log('Run the server in dev mode and use the admin API to pull threads.');

  // This would require database connection setup
  // For now, just show example of how to use the router with real data
  console.log(`
To test with real data:

1. Start the dev server: npm run dev

2. Use the admin API to list threads:
   curl http://localhost:3000/admin/addie/threads?limit=10

3. Get messages from a specific thread:
   curl http://localhost:3000/admin/addie/threads/{thread_id}

4. Manually test with the router by modifying this script.
`);
}

/**
 * Print routing rules summary
 */
function printRoutingRules(): void {
  console.log('\n📋 Current Routing Rules\n');
  console.log('=' .repeat(60));

  console.log('\n🎯 Expertise Areas (respond with tools):');
  for (const [key, rule] of Object.entries(ROUTING_RULES.expertise)) {
    console.log(`\n  ${rule.description}:`);
    console.log(`    Patterns: ${rule.patterns.join(', ')}`);
    console.log(`    Tools: ${rule.tools.join(', ')}`);
  }

  console.log('\n\n😀 React Patterns (emoji only):');
  for (const [key, rule] of Object.entries(ROUTING_RULES.reactWith)) {
    console.log(`\n  ${key}:`);
    console.log(`    Patterns: ${rule.patterns.join(', ')}`);
    console.log(`    Emoji: :${rule.emoji}:`);
  }

  console.log('\n\n🙈 Ignore Patterns:');
  console.log(`  ${ROUTING_RULES.ignore.patterns.join(', ')}`);
}

// Main
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runLive = args.includes('--live');
  const runDb = args.includes('--db');

  console.log('🧪 Addie Router Test Script');
  console.log('=' .repeat(60));

  // Always print rules
  printRoutingRules();

  // Always test quickMatch
  testQuickMatch();

  // Test full router if --live flag
  if (runLive) {
    await testFullRouter();
  } else {
    console.log('\n💡 Run with --live to test with actual Haiku API');
  }

  // Test with database if --db flag
  if (runDb) {
    await testWithDatabaseMessages();
  }

  console.log('\n✨ Done!');
}

main().catch(console.error);
