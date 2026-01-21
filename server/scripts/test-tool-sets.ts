#!/usr/bin/env npx ts-node --esm
/**
 * Tool Sets Router Test Script
 *
 * Tests the new tool-set-based routing against real production conversations.
 * Compares router tool set selections with what tools Sonnet actually called.
 *
 * Usage:
 *   npx ts-node --esm scripts/test-tool-sets.ts
 *
 * Or with DATABASE_URL:
 *   DATABASE_URL="postgres://..." npx ts-node --esm scripts/test-tool-sets.ts
 */

import pg from 'pg';
import Anthropic from '@anthropic-ai/sdk';
import { TOOL_SETS, getToolsForSets, getToolSetDescriptionsForRouter } from '../src/addie/tool-sets.js';

const { Pool } = pg;

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('fly.io') ? { rejectUnauthorized: false } : undefined,
});

// Anthropic client for router simulation
const anthropic = new Anthropic();

interface TestMessage {
  message_id: string;
  content: string;
  tools_used: string[] | null;
  router_decision: {
    action: string;
    reason: string;
    tools?: string[];
    tool_sets?: string[];
  } | null;
  created_at: Date;
}

/**
 * Fetch recent messages with router decisions from production
 */
async function fetchTestMessages(limit = 50): Promise<TestMessage[]> {
  const query = `
    SELECT
      m.message_id,
      u.content as user_content,
      m.tools_used,
      m.router_decision,
      m.created_at
    FROM addie_thread_messages m
    JOIN addie_thread_messages u ON u.thread_id = m.thread_id AND u.sequence_number = m.sequence_number - 1
    WHERE m.role = 'assistant'
      AND u.role = 'user'
      AND m.router_decision IS NOT NULL
      AND m.created_at > NOW() - INTERVAL '30 days'
    ORDER BY m.created_at DESC
    LIMIT $1
  `;

  const result = await pool.query(query, [limit]);
  return result.rows.map(row => ({
    message_id: row.message_id,
    content: row.user_content,
    tools_used: row.tools_used,
    router_decision: row.router_decision,
    created_at: row.created_at,
  }));
}

/**
 * Build the new router prompt for tool set selection
 */
function buildToolSetRouterPrompt(message: string, isAdmin = false): string {
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
 * Run the new router on a message
 */
async function runNewRouter(message: string): Promise<{ tool_sets: string[]; reason: string }> {
  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20250514',
    max_tokens: 200,
    messages: [{ role: 'user', content: buildToolSetRouterPrompt(message) }],
  });

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
    };
  } catch {
    console.error('Failed to parse router response:', text);
    return { tool_sets: ['knowledge'], reason: 'Parse error' };
  }
}

/**
 * Determine which tool set(s) a tool belongs to
 */
function getToolSetsForTool(toolName: string): string[] {
  const sets: string[] = [];
  for (const [setName, setDef] of Object.entries(TOOL_SETS)) {
    if (setDef.tools.includes(toolName)) {
      sets.push(setName);
    }
  }
  return sets;
}

/**
 * Analyze routing accuracy
 */
interface AnalysisResult {
  message_id: string;
  user_message: string;
  tools_sonnet_used: string[];
  old_router_tools: string[];
  new_router_sets: string[];
  new_router_reason: string;
  tools_available_with_new: string[];
  sonnet_tools_covered: boolean;
  coverage_details: {
    covered: string[];
    missing: string[];
  };
}

async function analyzeMessage(msg: TestMessage): Promise<AnalysisResult> {
  // Run new router
  const newRouterResult = await runNewRouter(msg.content);

  // Get tools that would be available with new routing
  const toolsAvailableWithNew = getToolsForSets(newRouterResult.tool_sets, false);

  // Check if Sonnet's tools would be covered
  const toolsUsed = msg.tools_used || [];
  const covered = toolsUsed.filter(t => toolsAvailableWithNew.includes(t));
  const missing = toolsUsed.filter(t => !toolsAvailableWithNew.includes(t));

  return {
    message_id: msg.message_id,
    user_message: msg.content.substring(0, 100) + (msg.content.length > 100 ? '...' : ''),
    tools_sonnet_used: toolsUsed,
    old_router_tools: msg.router_decision?.tools || [],
    new_router_sets: newRouterResult.tool_sets,
    new_router_reason: newRouterResult.reason,
    tools_available_with_new: toolsAvailableWithNew,
    sonnet_tools_covered: missing.length === 0,
    coverage_details: { covered, missing },
  };
}

/**
 * Print analysis report
 */
function printReport(results: AnalysisResult[]): void {
  console.log('\n' + '='.repeat(80));
  console.log('TOOL SETS ROUTER TEST REPORT');
  console.log('='.repeat(80) + '\n');

  // Summary stats
  const totalMessages = results.length;
  const fullyCovered = results.filter(r => r.sonnet_tools_covered).length;
  const coverageRate = ((fullyCovered / totalMessages) * 100).toFixed(1);

  console.log('SUMMARY');
  console.log('-'.repeat(40));
  console.log(`Total messages tested: ${totalMessages}`);
  console.log(`Fully covered by new routing: ${fullyCovered} (${coverageRate}%)`);
  console.log(`Missing tools: ${totalMessages - fullyCovered}`);

  // Tool set distribution
  const setUsage: Record<string, number> = {};
  for (const r of results) {
    for (const set of r.new_router_sets) {
      setUsage[set] = (setUsage[set] || 0) + 1;
    }
  }
  console.log('\nTOOL SET USAGE:');
  for (const [set, count] of Object.entries(setUsage).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / totalMessages) * 100).toFixed(1);
    console.log(`  ${set}: ${count} (${pct}%)`);
  }

  // Missing tools analysis
  const missingToolCounts: Record<string, number> = {};
  for (const r of results) {
    for (const tool of r.coverage_details.missing) {
      missingToolCounts[tool] = (missingToolCounts[tool] || 0) + 1;
    }
  }
  if (Object.keys(missingToolCounts).length > 0) {
    console.log('\nMISSING TOOLS (tools Sonnet used that wouldn\'t be available):');
    for (const [tool, count] of Object.entries(missingToolCounts).sort((a, b) => b[1] - a[1])) {
      const belongsTo = getToolSetsForTool(tool);
      console.log(`  ${tool}: ${count} times (belongs to: ${belongsTo.join(', ') || 'NONE'})`);
    }
  }

  // Detailed results for failures
  const failures = results.filter(r => !r.sonnet_tools_covered);
  if (failures.length > 0) {
    console.log('\n' + '='.repeat(80));
    console.log('DETAILED FAILURES');
    console.log('='.repeat(80));

    for (const f of failures.slice(0, 10)) {
      console.log('\n' + '-'.repeat(60));
      console.log(`Message: "${f.user_message}"`);
      console.log(`New router sets: [${f.new_router_sets.join(', ')}]`);
      console.log(`Reason: ${f.new_router_reason}`);
      console.log(`Tools Sonnet used: [${f.tools_sonnet_used.join(', ')}]`);
      console.log(`Missing: [${f.coverage_details.missing.join(', ')}]`);
    }
  }

  // Sample successes
  const successes = results.filter(r => r.sonnet_tools_covered && r.tools_sonnet_used.length > 0);
  if (successes.length > 0) {
    console.log('\n' + '='.repeat(80));
    console.log('SAMPLE SUCCESSES (tools correctly covered)');
    console.log('='.repeat(80));

    for (const s of successes.slice(0, 5)) {
      console.log('\n' + '-'.repeat(60));
      console.log(`Message: "${s.user_message}"`);
      console.log(`New router sets: [${s.new_router_sets.join(', ')}]`);
      console.log(`Reason: ${s.new_router_reason}`);
      console.log(`Tools Sonnet used: [${s.tools_sonnet_used.join(', ')}]`);
    }
  }
}

/**
 * Main entry point
 */
async function main() {
  console.log('Fetching test messages from database...');

  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable is required');
    console.log('\nUsage:');
    console.log('  DATABASE_URL="postgres://..." npx ts-node --esm scripts/test-tool-sets.ts');
    console.log('\nOr use fly proxy:');
    console.log('  fly proxy 15432:5432 -a agentic-advertising-db');
    console.log('  DATABASE_URL="postgres://user:pass@localhost:15432/db" npx ts-node ...');
    process.exit(1);
  }

  try {
    const messages = await fetchTestMessages(50);
    console.log(`Found ${messages.length} messages with router decisions\n`);

    if (messages.length === 0) {
      console.log('No messages found. Check your database connection.');
      process.exit(1);
    }

    console.log('Running new router on each message...');
    const results: AnalysisResult[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      process.stdout.write(`\r  Processing ${i + 1}/${messages.length}...`);

      try {
        const result = await analyzeMessage(msg);
        results.push(result);
      } catch (error) {
        console.error(`\nError processing message ${msg.message_id}:`, error);
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log('\n');
    printReport(results);

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
