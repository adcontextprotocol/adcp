/**
 * The hosted `comply()` routeStoryboard hook.
 *
 * - #7772: a storyboard whose declared test kit is a live-mode principal
 *   (`comply_controller_mode_gate`) must send its `from_test_kit` steps with
 *   that kit's key, not the owner's grading credential the hosted run copies
 *   into the run-level test kit. Proven through the real SDK `comply()`
 *   against a loopback seller that implements the gate.
 * - #7758: `requires: [multi_agent]` storyboards are routed with minted
 *   per-run credentials (collected for redaction), or skipped with a reason.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import { comply, loadStoryboardFile, type Storyboard } from '@adcp/sdk/testing';

vi.hoisted(() => {
  process.env.TRAINING_GOVERNANCE_CREDENTIAL_SECRET = require('node:crypto').randomBytes(32).toString('hex') as string;
});

import {
  LIVE_MODE_AGENT_KEY,
  createHostedRouteStoryboard,
  liveModeTestKitRoute,
} from '../../src/compliance/hosted-route-storyboard.js';
import type { TestKit } from '../../src/services/storyboards.js';

const REPO = resolve(__dirname, '../../..');
const SOURCE = resolve(REPO, 'static/compliance/source');
// A committed release bundle, so comply() has an index and test kits in CI.
const BUNDLE = resolve(REPO, 'dist/compliance/3.2.0-rc.7');
const BUNDLE_SCHEMAS = resolve(REPO, 'dist/schemas/3.2.0-rc.7');
const SELLER_URL = 'https://seller.route-hook.example/mcp';
const OWNER_TOKEN = 'owner-grading-credential-0123456789';

function loadKit(file: string): TestKit {
  return YAML.parse(readFileSync(resolve(SOURCE, 'test-kits', file), 'utf8')) as TestKit;
}

const LIVE_KIT = loadKit('acme-outdoor-live.yaml');
const SANDBOX_KIT = loadKit('acme-outdoor.yaml');
const MODE_GATE = loadStoryboardFile(resolve(SOURCE, 'universal/comply-controller-mode-gate.yaml'));
const GOVERNANCE_APPROVED = loadStoryboardFile(resolve(SOURCE, 'protocols/media-buy/scenarios/governance_approved.yaml'));

function hook(resolveTestKit: (id: string) => TestKit | undefined = () => undefined, secrets = new Set<string>()) {
  return createHostedRouteStoryboard({
    auth: { type: 'bearer', token: OWNER_TOKEN },
    resolveTestKit,
    secrets,
  });
}

const context = (agentUrl = SELLER_URL) => ({ agent_url: agentUrl, profile: {} as never });

describe('liveModeTestKitRoute (#7772)', () => {
  it('runs every from_test_kit step with the declared live-mode kit key, only against the agent under test', () => {
    const route = liveModeTestKitRoute(MODE_GATE, SELLER_URL, LIVE_KIT);
    if (!route || !('agents' in route)) throw new Error('expected a route');
    expect(route.default_agent).toBe(LIVE_MODE_AGENT_KEY);
    expect(route.agents).toEqual({ [LIVE_MODE_AGENT_KEY]: { url: SELLER_URL } });
    const steps = route.storyboard!.phases.flatMap(p => p.steps);
    expect(steps.map(s => s.auth)).toEqual([{ type: 'api_key', value: 'demo-acme-outdoor-live-v1' }]);
    // The loaded storyboard is not mutated.
    expect(MODE_GATE.phases[0].steps[0].auth).toEqual({ type: 'api_key', from_test_kit: true });
  });

  it('leaves sandbox kits, kits without a key, and mixed-auth storyboards alone', () => {
    expect(liveModeTestKitRoute(MODE_GATE, SELLER_URL, SANDBOX_KIT)).toBeUndefined();
    expect(liveModeTestKitRoute(MODE_GATE, SELLER_URL, undefined)).toBeUndefined();
    expect(liveModeTestKitRoute(MODE_GATE, SELLER_URL, { ...LIVE_KIT, auth: {} })).toBeUndefined();
    const mixed = structuredClone(MODE_GATE) as Storyboard;
    mixed.phases[0].steps.push({ ...mixed.phases[0].steps[0], id: 'sandbox_step', auth: undefined } as never);
    expect(liveModeTestKitRoute(mixed, SELLER_URL, LIVE_KIT)).toBeUndefined();
  });
});

describe('createHostedRouteStoryboard', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('routes live-mode kit storyboards and leaves ordinary storyboards to comply()', async () => {
    const route = hook(id => (id === MODE_GATE.id ? LIVE_KIT : SANDBOX_KIT));
    const live = await route(MODE_GATE, context());
    expect(live && 'agents' in live && live.default_agent).toBe(LIVE_MODE_AGENT_KEY);
    const ordinary = loadStoryboardFile(resolve(SOURCE, 'protocols/media-buy/scenarios/governance_agent_binding_acceptance.yaml'));
    expect(await route(ordinary, context())).toBeUndefined();
  });

  it('routes multi_agent governance storyboards with minted per-run credentials and collects them for redaction', async () => {
    const secrets = new Set<string>();
    const result = await hook(() => undefined, secrets)(GOVERNANCE_APPROVED, context());
    if (!result || !('agents' in result)) throw new Error(`expected a route: ${JSON.stringify(result)}`);
    expect(Object.keys(result.agents).sort()).toEqual(['governance', 'sales']);
    expect(result.agents.sales).toEqual({ url: SELLER_URL, auth: { type: 'bearer', token: OWNER_TOKEN } });
    expect(secrets.size).toBe(2);
    const [grader, seller] = [...secrets];
    expect(result.agents.governance.auth).toEqual({ type: 'bearer', token: grader });
    expect(JSON.stringify(result.storyboard)).toContain(seller);
    expect(JSON.stringify(result.agents.sales)).not.toContain(grader);
  });

  it('skips multi_agent storyboards with a reason when hosted governance is not enabled', async () => {
    vi.stubEnv('TRAINING_GOVERNANCE_CREDENTIAL_SECRET', '');
    const secrets = new Set<string>();
    const result = await hook(() => undefined, secrets)(GOVERNANCE_APPROVED, context());
    expect(result).toEqual({ skip: expect.stringContaining('not enabled') });
    expect(secrets.size).toBe(0);
  });

  it('skips multi_agent storyboards for agents that cannot hold a seller credential', async () => {
    const result = await hook()(GOVERNANCE_APPROVED, context('https://test-agent.adcontextprotocol.org/sales/mcp'));
    expect(result).toEqual({ skip: expect.stringContaining('cannot be registered') });
  });
});

// ── #7772 through the real SDK comply() ────────────────────────────────

interface Seen { authorization: string | undefined; tool?: string; scenario?: string }

const LIVE_KEY = 'demo-acme-outdoor-live-v1';

/** A single-endpoint seller that gates comply_test_controller on account mode. */
async function startGatedSeller(): Promise<{ url: string; seen: Seen[]; server: Server }> {
  const seen: Seen[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    if (req.method !== 'POST') {
      res.writeHead(405).end();
      return;
    }
    const msg = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      id?: number | string;
      method: string;
      params?: { name?: string; protocolVersion?: string; arguments?: Record<string, unknown> };
    };
    const args = msg.params?.arguments ?? {};
    seen.push({ authorization: req.headers.authorization, tool: msg.params?.name, scenario: args.scenario as string | undefined });
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    if (bearer !== OWNER_TOKEN && bearer !== LIVE_KEY) {
      res.writeHead(401, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'invalid_token' }));
      return;
    }
    if (msg.id === undefined) {
      res.writeHead(202).end();
      return;
    }
    let result: unknown;
    if (msg.method === 'initialize') {
      result = { protocolVersion: msg.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'gated-seller', version: '1.0.0' } };
    } else if (msg.method === 'tools/list') {
      result = { tools: ['get_adcp_capabilities', 'comply_test_controller'].map(name => ({ name, inputSchema: { type: 'object', properties: {} } })) };
    } else if (msg.method === 'tools/call') {
      let structured: Record<string, unknown>;
      if (msg.params?.name === 'get_adcp_capabilities') {
        structured = { adcp: { major_versions: [3], supported_versions: ['3.2'] }, supported_protocols: ['media_buy'] };
      } else if (args.scenario === 'list_scenarios') {
        structured = { success: true, scenarios: ['force_creative_status'] };
      } else if (bearer === LIVE_KEY) {
        // Live-mode account: refuse before dispatch.
        structured = { success: false, error: 'FORBIDDEN', error_detail: 'comply_test_controller requires a sandbox account.', context: args.context };
      } else {
        structured = { success: false, error: 'NOT_FOUND', error_detail: 'no sandbox creative matches', context: args.context };
      }
      result = { content: [{ type: 'text', text: JSON.stringify(structured) }], structuredContent: structured, ...(structured.success === false && { isError: true }) };
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
  });
  // SDK schema initialization can block this shared event loop longer than
  // Node's default idle-socket lifetime; retain fixture connections for the
  // entire bounded compliance run instead of racing a pooled-socket reset.
  server.keepAliveTimeout = 90_000;
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, seen, server };
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise(done => s.close(done))));
});

/** Step totals for the single storyboard the run selected. */
function stepTotals(result: Awaited<ReturnType<typeof comply>>) {
  const summary = result.summary as unknown as { total_steps: number; steps_passed: number; steps_failed: number };
  return { total: summary.total_steps, passed: summary.steps_passed, failed: summary.steps_failed };
}

describe('hosted suite runs grade comply_controller_mode_gate with the live-mode principal (#7772)', () => {
  async function run(withHook: boolean) {
    const seller = await startGatedSeller();
    servers.push(seller.server);
    const result = await comply(seller.url, {
      storyboards: ['comply_controller_mode_gate'],
      complianceDir: BUNDLE,
      schemaRoot: BUNDLE_SCHEMAS,
      auth: { type: 'bearer', token: OWNER_TOKEN },
      // What withHostedAuthTestKit does on every hosted suite run.
      test_kit: { auth: { api_key: OWNER_TOKEN, probe_task: 'list_creatives' } },
      allow_http: true,
      transport: { allowPrivateIp: true },
      ...(withHook && {
        routeStoryboard: createHostedRouteStoryboard({
          auth: { type: 'bearer', token: OWNER_TOKEN },
          resolveTestKit: id => (id === 'comply_controller_mode_gate' ? LIVE_KIT : undefined),
          secrets: new Set(),
        }),
      }),
    } as Parameters<typeof comply>[1]);
    return { result, seller };
  }

  it('reproduces the bug without the hook: the gate probe is sent as the owner sandbox principal', async () => {
    const { result, seller } = await run(false);
    const probe = seller.seen.find(s => s.scenario === 'force_creative_status');
    expect(probe?.authorization).toBe(`Bearer ${OWNER_TOKEN}`);
    expect(result.storyboards_executed).toEqual(['comply_controller_mode_gate']);
    // The optional phase fails, so the storyboard shows as untested 0/0.
    expect(stepTotals(result).passed).toBe(0);
  }, 60_000);

  it('sends the gate probe with the live-mode kit key and passes against a correct seller', async () => {
    const { result, seller } = await run(true);
    const probes = seller.seen.filter(s => s.scenario === 'force_creative_status');
    expect(probes.length).toBe(1);
    expect(probes[0].authorization).toBe(`Bearer ${LIVE_KEY}`);
    expect(result.storyboards_executed).toEqual(['comply_controller_mode_gate']);
    expect(stepTotals(result)).toEqual({ total: 1, passed: 1, failed: 0 });
    // The owner credential still authenticates discovery and the controller
    // probe; the live key carries only the gate probe (and its MCP handshake).
    const liveCalls = seller.seen.filter(s => s.authorization === `Bearer ${LIVE_KEY}` && s.tool !== undefined);
    expect(liveCalls.map(s => s.scenario)).toEqual(['force_creative_status']);
    expect(seller.seen.some(s => s.scenario === 'list_scenarios' && s.authorization === `Bearer ${OWNER_TOKEN}`)).toBe(true);
  }, 60_000);
});
