#!/usr/bin/env npx ts-node --esm
/**
 * Local Tool Sets Router Test Script
 *
 * Tests the new tool-set-based routing with sample messages locally.
 * No database required - uses hardcoded test cases.
 *
 * Usage:
 *   npx tsx scripts/test-tool-sets-local.ts
 */

import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env.local from server directory
const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env.local') });

import Anthropic from '@anthropic-ai/sdk';

// Get API key from environment (same pattern as other services)
const ANTHROPIC_API_KEY = process.env.ADDIE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY;

if (!ANTHROPIC_API_KEY) {
  console.error('ERROR: ANTHROPIC_API_KEY or ADDIE_ANTHROPIC_API_KEY is required');
  console.log('\nSet the environment variable:');
  console.log('  export ANTHROPIC_API_KEY="sk-ant-..."');
  console.log('  npx tsx scripts/test-tool-sets-local.ts');
  process.exit(1);
}
import {
  TOOL_SETS,
  getToolsForSets,
  getToolSetDescriptionsForRouter,
  buildUnavailableSetsHint,
  ALWAYS_AVAILABLE_TOOLS,
} from '../src/addie/tool-sets.js';

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

/**
 * Sample test messages with expected tool sets and tools that might be needed
 */
const TEST_CASES = [
  {
    message: "What is AdCP and how does it work?",
    expectedSets: ['knowledge'],
    expectedTools: ['search_docs'],
    category: 'protocol_learning',
  },
  {
    message: "Can you validate my adagents.json at https://example.com/.well-known/adagents.json?",
    expectedSets: ['agent_testing'],
    expectedTools: ['validate_adagents'],
    category: 'validation',
  },
  {
    message: "I'm looking for a DSP that supports AdCP. Can you help me find vendors?",
    expectedSets: ['directory'],
    expectedTools: ['search_members', 'request_introduction'],
    category: 'vendor_search',
  },
  {
    message: "How do I set up the Python SDK?",
    expectedSets: ['knowledge'],
    expectedTools: ['search_repos', 'search_docs'],
    category: 'implementation',
  },
  {
    message: "I want to join the working group on signals",
    expectedSets: ['member'],
    expectedTools: ['list_working_groups', 'join_working_group'],
    category: 'membership',
  },
  {
    message: "Can you help me create a media buy with The Trade Desk?",
    expectedSets: ['adcp_operations'],
    expectedTools: ['get_products', 'create_media_buy'],
    category: 'operations',
  },
  {
    message: "What's the latest news in agentic advertising?",
    expectedSets: ['knowledge'],
    expectedTools: ['get_recent_news', 'search_resources'],
    category: 'news',
  },
  {
    message: "Can you test if my AdCP agent is responding correctly? It's at https://agent.example.com",
    expectedSets: ['agent_testing'],
    expectedTools: ['probe_adcp_agent', 'test_adcp_agent'],
    category: 'testing',
  },
  {
    message: "I need to schedule a meeting with the protocol committee",
    expectedSets: ['meetings'],
    expectedTools: ['schedule_meeting', 'check_availability'],
    category: 'meetings',
  },
  {
    message: "Can you send an invoice to acme@example.com for their annual membership?",
    expectedSets: ['billing'],
    expectedTools: ['send_invoice', 'find_membership_products'],
    category: 'billing',
  },
  {
    message: "What did people say about the OpenRTB integration in Slack?",
    expectedSets: ['knowledge'],
    expectedTools: ['search_slack'],
    category: 'community',
  },
  {
    message: "Can you draft a GitHub issue for the missing creative validation?",
    expectedSets: ['content'],
    expectedTools: ['draft_github_issue'],
    category: 'content',
  },
  {
    message: "Hello! I'm new here.",
    expectedSets: [],
    expectedTools: [],
    category: 'greeting',
  },
  {
    message: "How does OpenRTB 3.0 compare to AdCOM?",
    expectedSets: ['knowledge'],
    expectedTools: ['search_repos', 'search_docs'],
    category: 'protocol_comparison',
  },
  {
    message: "I need to update my profile and also look for measurement partners",
    expectedSets: ['member', 'directory'],
    expectedTools: ['get_my_profile', 'update_my_profile', 'search_members'],
    category: 'multi_intent',
  },
  {
    message: "Test my agent and also explain how signals work",
    expectedSets: ['agent_testing', 'knowledge'],
    expectedTools: ['test_adcp_agent', 'search_docs'],
    category: 'multi_intent',
  },
  {
    message: "What's the TCF consent string format?",
    expectedSets: ['knowledge'],
    expectedTools: ['search_repos', 'search_docs'],
    category: 'protocol_details',
  },
  {
    message: "I want to get signals from LiveRamp and activate them in DV360",
    expectedSets: ['adcp_operations'],
    expectedTools: ['get_signals', 'activate_signal'],
    category: 'signals_operations',
  },
  {
    message: "Who are the founding members of AgenticAdvertising.org?",
    expectedSets: ['directory'],
    expectedTools: ['list_members'],
    category: 'directory_query',
  },
  {
    message: "Can you build a creative for a 300x250 display ad?",
    expectedSets: ['adcp_operations'],
    expectedTools: ['build_creative', 'list_creative_formats'],
    category: 'creative_operations',
  },
];

/**
 * Build the router prompt
 */
function buildRouterPrompt(message: string, isAdmin = false): string {
  const toolSetsSection = getToolSetDescriptionsForRouter(isAdmin);

  return `You are Addie's router. Analyze this message and select the appropriate tool SETS.

## Available Tool Sets
Select which CATEGORIES of tools will be needed. Each set contains multiple related tools.
${toolSetsSection}

## Tool Set Selection Guidelines
IMPORTANT: Select tool SETS based on the user's INTENT:
- Questions about AdCP, protocols, implementation → ["knowledge"]
- Questions about member profile, working groups, account → ["member"]
- Looking for vendors, partners, introductions → ["directory"]
- Testing/validating AdCP agent implementations → ["agent_testing"]
- Actually executing AdCP operations (media buys, creatives, signals) → ["adcp_operations"]
- Content workflows, GitHub issues, proposals → ["content"]
- Billing, invoices, payment links → ["billing"]
- Scheduling meetings, calendar → ["meetings"]
- Multiple intents? Include multiple sets: ["knowledge", "agent_testing"]
- General questions needing no tools → []

## Message
"${message.substring(0, 500)}"

## Instructions
Respond with a JSON object: {"tool_sets": ["set1", "set2"], "reason": "brief reason"}
Valid sets: knowledge, member, directory, agent_testing, adcp_operations, content, billing, meetings${isAdmin ? ', admin' : ''}
Empty array [] means respond without tools (general knowledge)

Respond with ONLY the JSON object, no other text.`;
}

/**
 * Run the router on a message
 */
async function runRouter(message: string): Promise<{ tool_sets: string[]; reason: string; latency_ms: number }> {
  const start = Date.now();
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20250514',
    max_tokens: 200,
    messages: [{ role: 'user', content: buildRouterPrompt(message) }],
  });

  const latency_ms = Date.now() - start;
  const text = response.content[0].type === 'text' ? response.content[0].text : '';

  try {
    let jsonStr = text.trim();
    if (jsonStr.startsWith('```')) {
      jsonStr = jsonStr.replace(/^```json?\n?/, '').replace(/\n?```$/, '');
    }
    const parsed = JSON.parse(jsonStr);
    return {
      tool_sets: Array.isArray(parsed.tool_sets) ? parsed.tool_sets : [],
      reason: parsed.reason || '',
      latency_ms,
    };
  } catch {
    console.error('Failed to parse router response:', text);
    return { tool_sets: ['knowledge'], reason: 'Parse error', latency_ms };
  }
}

/**
 * Check if expected tools would be available with selected sets
 */
function checkToolCoverage(selectedSets: string[], expectedTools: string[]): {
  available: string[];
  covered: string[];
  missing: string[];
} {
  const available = getToolsForSets(selectedSets, false);
  const covered = expectedTools.filter(t => available.includes(t));
  const missing = expectedTools.filter(t => !available.includes(t));
  return { available, covered, missing };
}

/**
 * Run all tests
 */
async function main() {
  console.log('=' .repeat(80));
  console.log('TOOL SETS ROUTER LOCAL TEST');
  console.log('=' .repeat(80));
  console.log('\nAvailable tool sets:');
  for (const [name, set] of Object.entries(TOOL_SETS)) {
    console.log(`  ${name}: ${set.tools.length} tools`);
  }
  console.log(`\nAlways available: ${ALWAYS_AVAILABLE_TOOLS.join(', ')}`);
  console.log('\n' + '-'.repeat(80));
  console.log(`Running ${TEST_CASES.length} test cases...\n`);

  const results: {
    message: string;
    category: string;
    expectedSets: string[];
    actualSets: string[];
    reason: string;
    latency_ms: number;
    setsMatch: boolean;
    toolsCovered: boolean;
    missingTools: string[];
  }[] = [];

  for (const tc of TEST_CASES) {
    process.stdout.write(`  Testing: ${tc.category}...`);

    try {
      const result = await runRouter(tc.message);
      const coverage = checkToolCoverage(result.tool_sets, tc.expectedTools);

      // Check if sets match (order-independent)
      const expectedSet = new Set(tc.expectedSets);
      const actualSet = new Set(result.tool_sets);
      const setsMatch = expectedSet.size === actualSet.size &&
        [...expectedSet].every(s => actualSet.has(s));

      results.push({
        message: tc.message.substring(0, 50) + (tc.message.length > 50 ? '...' : ''),
        category: tc.category,
        expectedSets: tc.expectedSets,
        actualSets: result.tool_sets,
        reason: result.reason,
        latency_ms: result.latency_ms,
        setsMatch,
        toolsCovered: coverage.missing.length === 0,
        missingTools: coverage.missing,
      });

      const status = setsMatch && coverage.missing.length === 0 ? '✓' : '✗';
      console.log(` ${status} (${result.latency_ms}ms)`);

    } catch (error) {
      console.log(' ERROR');
      console.error(`    ${error}`);
    }

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  // Print summary
  console.log('\n' + '='.repeat(80));
  console.log('RESULTS SUMMARY');
  console.log('='.repeat(80));

  const totalTests = results.length;
  const setsCorrect = results.filter(r => r.setsMatch).length;
  const toolsCovered = results.filter(r => r.toolsCovered).length;
  const avgLatency = results.reduce((sum, r) => sum + r.latency_ms, 0) / totalTests;

  console.log(`\nTotal tests: ${totalTests}`);
  console.log(`Sets exactly matched: ${setsCorrect}/${totalTests} (${((setsCorrect / totalTests) * 100).toFixed(1)}%)`);
  console.log(`Tools covered: ${toolsCovered}/${totalTests} (${((toolsCovered / totalTests) * 100).toFixed(1)}%)`);
  console.log(`Average latency: ${avgLatency.toFixed(0)}ms`);

  // Detailed failures
  const failures = results.filter(r => !r.setsMatch || !r.toolsCovered);
  if (failures.length > 0) {
    console.log('\n' + '-'.repeat(80));
    console.log('FAILURES/DISCREPANCIES:');
    console.log('-'.repeat(80));

    for (const f of failures) {
      console.log(`\n  Category: ${f.category}`);
      console.log(`  Message: "${f.message}"`);
      console.log(`  Expected sets: [${f.expectedSets.join(', ')}]`);
      console.log(`  Actual sets:   [${f.actualSets.join(', ')}]`);
      console.log(`  Reason: ${f.reason}`);
      if (f.missingTools.length > 0) {
        console.log(`  Missing tools: [${f.missingTools.join(', ')}]`);
      }
      console.log(`  Sets match: ${f.setsMatch ? 'YES' : 'NO'}`);
      console.log(`  Tools covered: ${f.toolsCovered ? 'YES' : 'NO'}`);
    }
  }

  // Token savings estimate
  console.log('\n' + '-'.repeat(80));
  console.log('ESTIMATED TOKEN SAVINGS:');
  console.log('-'.repeat(80));

  // Estimate tokens per tool definition (~100 tokens each)
  const TOKENS_PER_TOOL = 100;
  const allToolsCount = Object.values(TOOL_SETS).reduce((sum, set) => sum + set.tools.length, 0);
  const tokensWithAllTools = allToolsCount * TOKENS_PER_TOOL;

  for (const r of results) {
    if (r.actualSets.length > 0) {
      const toolsInSets = getToolsForSets(r.actualSets, false).length;
      const tokensSaved = (allToolsCount - toolsInSets) * TOKENS_PER_TOOL;
      const savingsPct = ((tokensSaved / tokensWithAllTools) * 100).toFixed(0);
      console.log(`  ${r.category}: ${toolsInSets} tools loaded (${savingsPct}% token savings)`);
    }
  }

  // Show unavailable hint example
  console.log('\n' + '-'.repeat(80));
  console.log('SAMPLE UNAVAILABLE SETS HINT (for knowledge set only):');
  console.log('-'.repeat(80));
  console.log(buildUnavailableSetsHint(['knowledge'], false));
}

main().catch(console.error);
