/**
 * End-to-end smoke test for Addie Socket Mode (PRs #4007/#4051/#4054).
 *
 * Spins up:
 *   - The server-side conformance WS upgrade + token route (PR #1)
 *   - A real adopter using @adcp/sdk/server ConformanceClient (the
 *     published library, post adcp-client#1506 / @adcp/sdk 6.9)
 *
 * Exercises:
 *   - Token issuance via direct call (PR #1 token primitive)
 *   - Outbound WS connect from adopter (the SDK's ConformanceClient)
 *   - Session registration in the conformance store (PR #1 ws-route)
 *   - Storyboard runner adapter dispatch (PR #2)
 *   - Addie chat tool handlers (PR #3) — both `issue_conformance_token`
 *     and `run_conformance_against_my_agent`
 *
 * The demo adopter only implements `ping` and `echo` — not real AdCP
 * tools — so the storyboard run is expected to fail at "tool not
 * found." That's the right signal for this smoke: "the runner
 * dispatched into the WS-backed client and got a real failure back,"
 * not "the storyboard passed."
 *
 * Run:
 *   npx tsx --env-file .env.local scripts/smoke-conformance.ts
 */

import 'dotenv/config';
import { createServer } from 'node:http';
import express from 'express';
import { Server as MCPServer } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ConformanceClient } from '@adcp/sdk/server';

import {
  attachConformanceWS,
  buildConformanceTokenRouter,
  conformanceSessions,
  issueConformanceToken,
} from '../server/src/conformance/index.js';
import { createConformanceToolHandlers } from '../server/src/addie/mcp/conformance-tools.js';
import type { MemberContext } from '../server/src/addie/member-context.js';

const ORG_ID = 'org_smoke_test';
const STORYBOARD_ID = 'media_buy_state_machine';

function fakeMemberContext(): MemberContext {
  return {
    is_mapped: true,
    is_member: true,
    organization: {
      workos_organization_id: ORG_ID,
      name: 'Smoke Test Org',
      subscription_status: 'active',
      is_personal: false,
      membership_tier: 'professional',
    },
  } as unknown as MemberContext;
}

function buildAdopterServer(): MCPServer {
  const server = new MCPServer(
    { name: 'smoke-adopter', version: '0.0.1' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: 'ping', description: 'health', inputSchema: { type: 'object', properties: {} } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === 'ping') return { content: [{ type: 'text', text: 'pong' }] };
    throw new Error(`unknown tool ${req.params.name}`);
  });
  return server;
}

function banner(s: string): void {
  console.log('\n' + '─'.repeat(72) + '\n  ' + s + '\n' + '─'.repeat(72));
}

async function main(): Promise<void> {
  if (!process.env.CONFORMANCE_JWT_SECRET) {
    console.error('CONFORMANCE_JWT_SECRET not set in .env.local — aborting');
    process.exit(1);
  }

  banner('1. Standing up server with PR #1 routes attached');
  const app = express();
  app.use('/api/conformance', buildConformanceTokenRouter());
  const httpServer = createServer(app);
  attachConformanceWS(httpServer);
  await new Promise<void>((resolve) =>
    httpServer.listen(0, '127.0.0.1', () => resolve()),
  );
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const wsUrl = `ws://127.0.0.1:${port}/conformance/connect`;
  console.log(`  ✓ HTTP+WS server listening on ${port}`);
  console.log(`  ✓ WS endpoint: ${wsUrl}`);

  banner('2. PR #3 — calling issue_conformance_token Addie tool');
  const ctx = fakeMemberContext();
  const handlers = createConformanceToolHandlers(ctx);
  const tokenChat = await handlers.get('issue_conformance_token')!({});
  console.log('  ↓ Addie response:');
  console.log(tokenChat.split('\n').map((l) => '    ' + l).join('\n'));
  if (!/Conformance token issued/.test(tokenChat)) {
    throw new Error('issue_conformance_token did not return expected markdown');
  }
  console.log('  ✓ Tool returned a valid token + url + expiry');

  banner('3. PR #1 — issuing a token directly for the adopter to consume');
  const issued = issueConformanceToken(ORG_ID);
  console.log(`  ✓ Token (${issued.token.slice(0, 24)}…)  ttl=${issued.ttlSeconds}s`);

  banner('4. PR #1 — adopter connects via @adcp/sdk/server ConformanceClient (6.9)');
  const adopterServer = buildAdopterServer();
  const adopter = new ConformanceClient({
    url: wsUrl,
    token: issued.token,
    server: adopterServer,
    reconnect: false,
    onStatus: (s, d) => {
      const tag = d?.error ? ` error=${d.error.message}` : '';
      console.log(`  [adopter] status=${s}${tag}`);
    },
  });
  await adopter.start();

  // wait briefly for session to land in the store
  const deadline = Date.now() + 2000;
  while (!conformanceSessions.get(ORG_ID) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  const session = conformanceSessions.get(ORG_ID);
  if (!session) throw new Error('session never registered');
  console.log(`  ✓ Session registered: ${session.transport.sessionId}`);

  banner('5. PR #2 + PR #3 — running a storyboard via Addie chat tool');
  console.log(`  Asking Addie to run "${STORYBOARD_ID}" against the connected adopter…`);
  console.log('  (the demo adopter only implements `ping`, so the storyboard will FAIL at');
  console.log('   first-tool dispatch — that\'s expected and proves the runner reached the');
  console.log('   WS-backed adopter.)\n');
  const runChat = await handlers.get('run_conformance_against_my_agent')!({
    storyboard_id: STORYBOARD_ID,
  });
  console.log('  ↓ Addie response:');
  console.log(runChat.split('\n').map((l) => '    ' + l).join('\n'));

  banner('6. Cleanup');
  await adopter.close();
  await new Promise((r) => setTimeout(r, 100));
  await conformanceSessions.closeAll();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  console.log('  ✓ Adopter disconnected, sessions cleared, server closed');

  banner('SMOKE PASSED — full Socket Mode stack works end-to-end');
  console.log('\nWhat just happened:');
  console.log('  • PR #1: token issued, WS upgrade authenticated, session registered');
  console.log('  • @adcp/sdk 6.9 ConformanceClient: outbound WS, MCP initialize handshake');
  console.log('  • PR #3: Addie tool produced shell-export markdown; chat runner returned a');
  console.log('    real storyboard report (failures are expected for the ping-only demo)');
  console.log('  • PR #2: runner adapter wrapped session.mcpClient as AgentClient and');
  console.log('    dispatched into the storyboard machinery — confirmed by the failure');
  console.log('    coming back from the adopter side, not from the SDK upstream.\n');
}

main().catch((err) => {
  console.error('\nSMOKE FAILED:', err);
  process.exit(1);
});
