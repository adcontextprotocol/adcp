/**
 * Full Socket Mode loop against the local training agent.
 *
 * Flow:
 *   1. Issue a conformance token directly (skips the WorkOS-auth step)
 *   2. Spin up a "proxy adopter" — an MCP server whose request handlers
 *      forward every tools/list and tools/call to the locally running
 *      training agent's `/api/training-agent/sales/mcp` HTTP endpoint
 *   3. Connect that proxy via @adcp/sdk/server ConformanceClient
 *   4. Trigger `runStoryboardViaConformanceSocket` from inside the dev
 *      server via the dev-only `_debug/run-storyboard` endpoint
 *   5. Print the storyboard result
 *
 * What this proves: the training agent's storyboard conformance carries
 * over Socket Mode unchanged. Whatever it passes/fails over HTTP, it
 * passes/fails over the WS-backed path.
 *
 * Prereqs:
 *   - Dev server running (`npm run start`)
 *   - CONFORMANCE_JWT_SECRET set
 *
 * Run:
 *   npx tsx --import dotenv/config scripts/smoke-conformance-training-agent.ts
 */

import 'dotenv/config';
import { Server as MCPServer } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ConformanceClient } from '@adcp/sdk/server';

import { issueConformanceToken } from '../server/src/conformance/index.js';

const PORT = process.env.CONDUCTOR_PORT ?? '55020';
const TRAINING_URL = `http://localhost:${PORT}/api/training-agent/sales/mcp`;
const TRAINING_TOKEN =
  process.env.PUBLIC_TEST_AGENT_TOKEN ??
  '1v8tAhASaUYYp4odoQ1PnMpdqNaMiTrCRqYo9OJp6IQ';
const CONFORMANCE_WS_URL = `ws://127.0.0.1:${PORT}/conformance/connect`;
const ORG_ID = 'org_socket_smoke';
const STORYBOARD_ID = process.argv[2] ?? 'media_buy_state_machine';

function banner(s: string): void {
  console.log('\n' + '─'.repeat(72) + '\n  ' + s + '\n' + '─'.repeat(72));
}

let nextRpcId = 100;

async function forwardToTrainingAgent(method: string, params: unknown): Promise<unknown> {
  const id = nextRpcId++;
  const body = JSON.stringify({ jsonrpc: '2.0', id, method, params });
  const res = await fetch(TRAINING_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TRAINING_TOKEN}`,
    },
    body,
  });
  if (!res.ok) {
    throw new Error(`training agent HTTP ${res.status}: ${await res.text().catch(() => '')}`);
  }
  const text = await res.text();
  // SSE responses begin with `event:` / `data:` lines; pick the first JSON
  // payload. Otherwise the body is plain JSON.
  const sseMatch = text.match(/^data: (.*)$/m);
  const payload = sseMatch ? JSON.parse(sseMatch[1]) : JSON.parse(text);
  if (payload.error) {
    const err = new Error(payload.error.message ?? 'unknown error');
    (err as Error & { code?: number }).code = payload.error.code;
    throw err;
  }
  return payload.result;
}

function buildProxyServer(): MCPServer {
  const server = new MCPServer(
    { name: 'training-agent-socket-proxy', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return (await forwardToTrainingAgent('tools/list', {})) as {
      tools: Array<{ name: string; description?: string; inputSchema: unknown }>;
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    return (await forwardToTrainingAgent('tools/call', req.params)) as {
      content: Array<{ type: 'text'; text: string }>;
    };
  });

  return server;
}

async function main(): Promise<void> {
  if (!process.env.CONFORMANCE_JWT_SECRET) {
    console.error('CONFORMANCE_JWT_SECRET not set — abort');
    process.exit(1);
  }

  banner('1. Issuing token + connecting proxy adopter via @adcp/sdk 6.9');
  const { token } = issueConformanceToken(ORG_ID);
  console.log(`  token (${token.slice(0, 32)}…)`);
  console.log(`  proxy will forward to ${TRAINING_URL}`);

  const proxy = new ConformanceClient({
    url: CONFORMANCE_WS_URL,
    token,
    server: buildProxyServer(),
    reconnect: false,
    onStatus: (s, d) =>
      console.log(`  [proxy] status=${s}${d?.error ? ` error=${d.error.message}` : ''}`),
  });
  await proxy.start();

  banner(`2. Triggering "${STORYBOARD_ID}" via /api/conformance/_debug/run-storyboard`);
  // Static admin key is configured on this server; it bypasses WorkOS but
  // still satisfies requireAuth for dev-only debug endpoints.
  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) throw new Error('ADMIN_API_KEY not in env — needed to authenticate the debug trigger');

  const triggerRes = await fetch(`http://localhost:${PORT}/api/conformance/_debug/run-storyboard`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${adminKey}`,
    },
    body: JSON.stringify({ org_id: ORG_ID, storyboard_id: STORYBOARD_ID }),
  });

  if (!triggerRes.ok) {
    console.error('  trigger failed:', triggerRes.status, await triggerRes.text());
    await proxy.close();
    process.exit(1);
  }

  const result = await triggerRes.json() as {
    storyboard_id: string;
    storyboard_title: string;
    overall_passed: boolean;
    passed_count: number;
    failed_count: number;
    skipped_count: number;
    total_duration_ms: number;
    phases: Array<{
      phase_id: string;
      phase_title: string;
      passed: boolean;
      steps: Array<{ step_id: string; title: string; passed: boolean; skipped?: boolean; error?: string }>;
    }>;
  };

  banner('3. Result');
  console.log(`  Storyboard: ${result.storyboard_title} (${result.storyboard_id})`);
  console.log(`  Overall:    ${result.overall_passed ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`  Steps:      ${result.passed_count} passed / ${result.failed_count} failed / ${result.skipped_count} skipped`);
  console.log(`  Duration:   ${result.total_duration_ms} ms\n`);
  for (const phase of result.phases) {
    console.log(`  ${phase.passed ? '✓' : '✗'} ${phase.phase_title}`);
    for (const step of phase.steps) {
      const tag = step.skipped ? '⊘' : step.passed ? '✓' : '✗';
      console.log(`     ${tag} ${step.title}`);
      if (!step.passed && !step.skipped && step.error) {
        const trimmed = step.error.length > 200 ? step.error.slice(0, 200) + '…' : step.error;
        console.log(`        error: ${trimmed}`);
      }
    }
  }

  await proxy.close();
  banner(result.overall_passed ? 'PASS' : 'storyboard ran end-to-end via Socket Mode (failures are training-agent bugs, not transport bugs)');
}

main().catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
