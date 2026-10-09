/**
 * Wire-level proof for #7758 credential isolation: run a routed storyboard
 * through the real @adcp/sdk runner against two loopback MCP agents and
 * record which credential each one receives.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';
import { runStoryboard, type Storyboard } from '@adcp/sdk/testing';

import {
  hostedMultiAgentRoutingForStoryboard,
  withHostedMultiAgentRouting,
} from '../../src/compliance/hosted-multi-agent-routing.js';

const SELLER_TOKEN = 'owner-secret-seller-token-0123456789';
const GOVERNANCE_TOKEN = 'grader-governance-token-abcdef0123';
const SELLER_GOVERNANCE_CREDENTIAL = 'seller-governance-credential-0123456';

interface Seen { authorization: string | undefined; method: string; tool?: string; body: string }

function capabilities(protocols: string[]) {
  return {
    adcp: { major_versions: [3], supported_versions: ['3.1'] },
    supported_protocols: protocols,
  };
}

const RESPONSES: Record<string, unknown> = {
  sync_plans: { plans: [] },
  sync_governance: { accounts: [] },
  get_products: { products: [], cache_scope: 'public' },
};

async function startAgent(name: string, protocols: string[], tools: string[]): Promise<{ url: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    if (req.method !== 'POST') {
      seen.push({ authorization: req.headers.authorization, method: req.method ?? '', body });
      res.writeHead(405).end();
      return;
    }
    const msg = JSON.parse(body) as { id?: number | string; method: string; params?: { name?: string; protocolVersion?: string } };
    seen.push({ authorization: req.headers.authorization, method: msg.method, tool: msg.params?.name, body });
    if (msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    if (!['initialize', 'tools/list', 'tools/call'].includes(msg.method)) {
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }));
      return;
    }
    let result: unknown;
    if (msg.method === 'initialize') {
      result = { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name, version: '1.0.0' } };
    } else if (msg.method === 'tools/list') {
      result = {
        tools: ['get_adcp_capabilities', ...tools].map(t => ({ name: t, inputSchema: { type: 'object', properties: {} } })),
      };
    } else if (msg.method === 'tools/call') {
      const structured = RESPONSES[msg.params?.name ?? ''] ?? (msg.params?.name === 'get_adcp_capabilities' ? capabilities(protocols) : {});
      result = { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured };
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, seen, server };
}

const storyboard = {
  id: 'hosted_multi_agent_wire',
  version: '1.0.0',
  title: 'Hosted multi-agent wire isolation',
  category: 'test',
  summary: '',
  narrative: '',
  requires: ['multi_agent'],
  default_agent: 'sales',
  context: { governance_agent_url: 'https://test-agent.adcontextprotocol.org', seller_agent_url: 'https://seller.example.com' },
  agent: { interaction_model: '*', capabilities: [] },
  caller: { role: 'buyer_agent' },
  phases: [{
    id: 'p1',
    title: 'governance then seller',
    steps: [
      { id: 'sync_plans', title: 'plan', task: 'sync_plans', agent: 'governance', sample_request: { plans: [] } },
      {
        id: 'sync_governance',
        title: 'register governance',
        task: 'sync_governance',
        agent: 'sales',
        sample_request: {
          accounts: [{
            account: { brand: { domain: 'hosted-grader.adcontextprotocol.org' }, operator: 'pinnacle-agency.example' },
            governance_agents: [{ url: '$context.governance_agent_url', authentication: { schemes: ['Bearer'], credentials: 'gov-token-placeholder-000000000000000' } }],
          }],
        },
      },
      { id: 'get_products', title: 'products', task: 'get_products', agent: 'sales', sample_request: { brief: 'x' } },
    ],
  }],
} as unknown as Storyboard;

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise(resolve => s.close(resolve))));
});

describe('hosted multi-agent routing on the wire', () => {
  it('sends only the owner credential to the seller and only the grader credential to the governance agent', async () => {
    const seller = await startAgent('seller', ['media_buy'], ['get_products', 'sync_governance']);
    const governance = await startAgent('governance', ['governance'], ['sync_plans']);
    servers.push(seller.server, governance.server);

    const routing = hostedMultiAgentRoutingForStoryboard({
      storyboard,
      agentUnderTest: { url: seller.url, auth: { type: 'bearer', token: SELLER_TOKEN } },
      governance: {
        url: 'https://test-agent.adcontextprotocol.org/governance/mcp',
        auth: { type: 'bearer', token: GOVERNANCE_TOKEN },
        callerIdentity: 'https://hosted-grader.adcontextprotocol.org/buyer',
        sellerCredential: SELLER_GOVERNANCE_CREDENTIAL,
        runNonce: 'wire-run-nonce',
      },
    });
    if (routing.kind !== 'routed') throw new Error(`expected routed: ${JSON.stringify(routing)}`);
    // Only the endpoint is swapped for the loopback stand-in; the auth the
    // helper chose for each route is what goes on the wire.
    routing.agents.governance = { ...routing.agents.governance, url: governance.url };

    const result = await runStoryboard('', routing.storyboard, withHostedMultiAgentRouting({
      // Hosted runs set the owner credential at run level and copy it into
      // the test kit (withHostedAuthTestKit). Neither may reach governance.
      auth: { type: 'bearer', token: SELLER_TOKEN },
      test_kit: { auth: { api_key: SELLER_TOKEN, probe_task: 'list_creatives' } },
      allow_http: true,
      transport: { allowPrivateIp: true },
    } as Parameters<typeof runStoryboard>[2], routing));

    expect(governance.seen.length).toBeGreaterThan(0);
    expect(seller.seen.length).toBeGreaterThan(0);
    for (const req of governance.seen) {
      expect(req.authorization).toBe(`Bearer ${GOVERNANCE_TOKEN}`);
      expect(req.body).not.toContain(SELLER_TOKEN);
      expect(req.body).not.toContain(SELLER_GOVERNANCE_CREDENTIAL);
    }
    for (const req of seller.seen) {
      expect(req.authorization).toBe(`Bearer ${SELLER_TOKEN}`);
      expect(req.body).not.toContain(GOVERNANCE_TOKEN);
    }
    // The step that failed in #7758 reaches governance, not the seller.
    expect(governance.seen.some(r => r.tool === 'sync_plans')).toBe(true);
    expect(seller.seen.some(r => r.tool === 'sync_plans')).toBe(false);
    expect(seller.seen.some(r => r.tool === 'get_products')).toBe(true);
    // The seller receives its per-run governance credential in sync_governance.
    const syncGovernance = seller.seen.find(r => r.tool === 'sync_governance');
    expect(syncGovernance?.body).toContain(SELLER_GOVERNANCE_CREDENTIAL);
    // Both routed steps actually executed, so the isolation checks above are
    // not vacuous.
    const steps = result.phases.flatMap(p => p.steps);
    expect(steps.map(s => [s.step_id, s.skipped ?? false])).toEqual([['sync_plans', false], ['sync_governance', false], ['get_products', false]]);
    expect(steps.every(s => s.passed)).toBe(true);
  }, 60_000);
});
