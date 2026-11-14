/**
 * Every tool the training agent registers echoes the caller's `context`
 * unchanged (docs/building/by-layer/L2/context-sessions.mdx, "Normative echo
 * contract"): on success, on error, and on idempotent replay.
 *
 * Rule 5 only requires the echo to be the same parsed JSON value. These tests
 * also require the same serialization, which the in-process router preserves,
 * so a reordered or re-encoded echo is caught as well as a changed one.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import YAML from 'yaml';
import { TRAINING_AGENT_PREVIEW_ADCP_VERSION } from '../candidate-version.js';

process.env.PUBLIC_TEST_AGENT_TOKEN = 'test-token';

const TENANTS = ['sales', 'signals', 'governance', 'creative', 'creative-builder', 'brand', 'si'] as const;
/** Per-tenant routes plus the legacy single-URL `/mcp` monolith. */
const ROUTES = [...TENANTS, 'legacy'] as const;
type Route = typeof ROUTES[number];

/** Served releases each request is pinned to: the default, 3.1, and the opt-in preview. */
const VERSIONS: ReadonlyArray<string | undefined> = [
  undefined,
  '3.1',
  ...(TRAINING_AGENT_PREVIEW_ADCP_VERSION ? [TRAINING_AGENT_PREVIEW_ADCP_VERSION] : []),
];

/** Opaque caller context: nested members out of key order, an array, every JSON type. */
const CONTEXT = {
  trace_id: 'ctx-echo-trace',
  nested: { zeta: 'last', alpha: 'first' },
  list: ['b', 'a'],
  count: 3,
  ratio: 2.5,
  flag: true,
  empty: null,
  text: 'é ✓ "quoted"',
} as const;
const CONTEXT_JSON = JSON.stringify(CONTEXT);

/**
 * Tools whose MCP input schema rejects a request with no required fields
 * before AdCP code runs (`-32602`, no structuredContent, no context). The SDK
 * registers these from `customTools` and its own zod schemas; framework tools
 * validate at the AdCP layer instead. Tracked in adcontextprotocol/adcp-client#3666.
 * When the SDK fix lands these tools start echoing and the test below fails:
 * delete the entry.
 */
const SDK_INPUT_SCHEMA_CONTEXT_GAP: Readonly<Record<Route, readonly string[]>> = {
  sales: [
    'build_creative', 'comply_test_controller', 'get_reporting_status', 'list_account_changes',
    'preview_creative', 'report_usage', 'sync_agent_notification_configs', 'sync_catalogs',
    'sync_governance', 'sync_principal', 'sync_reporting_receipts', 'sync_reporting_status',
    'tasks_get', 'validate_input',
  ],
  signals: ['comply_test_controller', 'sync_governance', 'tasks_get'],
  governance: ['comply_test_controller', 'report_plan_adjustment', 'tasks_get'],
  creative: ['comply_test_controller', 'report_usage', 'sync_governance', 'tasks_get', 'validate_input'],
  'creative-builder': ['comply_test_controller', 'sync_governance', 'tasks_get', 'validate_input'],
  brand: [
    'comply_test_controller', 'search_brands', 'sync_governance', 'tasks_get',
    'verify_brand_claim', 'verify_brand_claims',
  ],
  si: ['sync_catalogs', 'tasks_get'],
  legacy: [],
};

/**
 * The SDK's `tasks_get` input schema does not declare `context`, so MCP input
 * parsing strips it and even a valid request gets no echo (adcp-client#3666).
 * The legacy monolith registers its own `tasks_get`. When the SDK fix lands
 * the test below fails: delete this entry.
 */
const SDK_STRIPS_CONTEXT: ReadonlySet<string> = new Set(['tasks_get']);

/** Storyboard sample requests tried per tool before the schema-derived fallback. */
const MAX_SAMPLES_PER_TOOL = 2;

interface ToolDescriptor {
  name: string;
  inputSchema?: Record<string, unknown>;
}

interface RpcResponse {
  result?: {
    structuredContent?: Record<string, unknown>;
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  error?: unknown;
}

let baseUrl = '';
let closeServer: () => Promise<void> = async () => {};
let rpcId = 0;

function routeUrl(route: Route): string {
  return route === 'legacy' ? `${baseUrl}/mcp` : `${baseUrl}/${route}/mcp`;
}

async function rpc(url: string, method: string, params?: unknown): Promise<RpcResponse> {
  rpcId += 1;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: 'Bearer test-token',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, ...(params !== undefined && { params }) }),
  });
  return response.json() as Promise<RpcResponse>;
}

function callTool(url: string, name: string, args: Record<string, unknown>): Promise<RpcResponse> {
  return rpc(url, 'tools/call', { name, arguments: args });
}

const toolLists = new Map<Route, ToolDescriptor[]>();

async function toolsFor(route: Route): Promise<ToolDescriptor[]> {
  const cached = toolLists.get(route);
  if (cached) return cached;
  const url = routeUrl(route);
  await rpc(url, 'initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'context-echo', version: '1' }, capabilities: {} });
  const listed = await rpc(url, 'tools/list') as { result?: { tools?: ToolDescriptor[] } };
  const tools = listed.result?.tools ?? [];
  toolLists.set(route, tools);
  return tools;
}

/**
 * Where the response carries the caller's context: `structuredContent.context`
 * and the context inside any `content[].text` that mirrors the body as JSON.
 */
function echoedContexts(response: RpcResponse): { structured: unknown; mirrors: unknown[] } {
  const mirrors: unknown[] = [];
  for (const block of response.result?.content ?? []) {
    if (block.type !== 'text' || typeof block.text !== 'string' || !block.text.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(block.text) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && 'context' in parsed) mirrors.push(parsed.context);
    } catch { /* prose summary, not a JSON mirror */ }
  }
  return { structured: response.result?.structuredContent?.context, mirrors };
}

function expectContextEchoed(response: RpcResponse, label: string): void {
  const { structured, mirrors } = echoedContexts(response);
  expect(structured, `${label}: ${JSON.stringify(response).slice(0, 600)}`).toEqual(CONTEXT);
  expect(JSON.stringify(structured), label).toBe(CONTEXT_JSON);
  for (const mirror of mirrors) expect(JSON.stringify(mirror), `${label} (text mirror)`).toBe(CONTEXT_JSON);
}

function reachedAdcpLayer(response: RpcResponse): boolean {
  const structured = response.result?.structuredContent;
  return structured !== undefined && structured !== null && typeof structured === 'object';
}

function isSdkInputSchemaRejection(response: RpcResponse): boolean {
  const text = response.result?.content?.[0]?.text ?? '';
  return response.result?.isError === true && !reachedAdcpLayer(response) && text.includes('-32602');
}

// ── Valid requests for the handler path ─────────────────────────────

const storyboardSamples = new Map<string, Record<string, unknown>[]>();

function collectSamples(node: unknown): void {
  if (Array.isArray(node)) {
    for (const child of node) collectSamples(child);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const record = node as Record<string, unknown>;
  const sample = record.sample_request;
  if (typeof record.task === 'string' && sample && typeof sample === 'object' && !Array.isArray(sample)) {
    const samples = storyboardSamples.get(record.task) ?? [];
    samples.push(sample as Record<string, unknown>);
    storyboardSamples.set(record.task, samples);
  }
  for (const child of Object.values(record)) collectSamples(child);
}

function loadStoryboardSamples(dir: string): void {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) loadStoryboardSamples(file);
    else if (entry.isFile() && entry.name.endsWith('.yaml')) collectSamples(YAML.parse(readFileSync(file, 'utf8')));
  }
}

/** Storyboard idempotency keys are runner directives; give each call a fresh key. */
function materialize(value: unknown): unknown {
  if (typeof value === 'string') return value.startsWith('$generate:uuid_v4') ? randomUUID() : value;
  if (Array.isArray(value)) return value.map(materialize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, materialize(child)]));
  }
  return value;
}

/** Smallest value the advertised input schema accepts, for a tool no storyboard exercises. */
function minimalValue(schema: Record<string, unknown> | undefined): unknown {
  if (!schema) return {};
  if (Array.isArray(schema.enum)) return schema.enum[0];
  if ('const' in schema) return schema.const;
  const variants = (schema.anyOf ?? schema.oneOf) as Record<string, unknown>[] | undefined;
  if (variants?.length) return minimalValue(variants[0]);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case 'string': return schema.format === 'uri' ? 'https://context-echo.example/' : 'context-echo-probe-0001';
    case 'integer':
    case 'number': return typeof schema.minimum === 'number' ? schema.minimum : 1;
    case 'boolean': return false;
    case 'array': {
      const minItems = typeof schema.minItems === 'number' ? schema.minItems : 0;
      return Array.from({ length: minItems }, () => minimalValue(schema.items as Record<string, unknown> | undefined));
    }
    default: {
      const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
      const required = (schema.required ?? []) as string[];
      return Object.fromEntries(required.map(key => [key, minimalValue(properties[key])]));
    }
  }
}

function candidateRequests(tool: ToolDescriptor): Record<string, unknown>[] {
  const samples = (storyboardSamples.get(tool.name) ?? [])
    .slice(0, MAX_SAMPLES_PER_TOOL)
    .map(sample => materialize(sample) as Record<string, unknown>);
  return [...samples, minimalValue(tool.inputSchema) as Record<string, unknown>];
}

// ── Lifecycle ───────────────────────────────────────────────────────

/**
 * Training-agent modules load after `index.js`, as in production: importing
 * a handler module first resolves their import cycle in a different order and
 * leaves the legacy monolith's tool list with unset entries.
 */
async function clearTrainingState(): Promise<void> {
  const [{ clearAccountStore }, { clearSessions }, { clearSiSessions }, { clearForcedTaskCompletions }] = await Promise.all([
    import('../account-handlers.js'),
    import('../state.js'),
    import('../si-handlers.js'),
    import('../comply-test-controller.js'),
  ]);
  clearSessions();
  clearAccountStore();
  clearSiSessions();
  clearForcedTaskCompletions();
}

beforeAll(async () => {
  loadStoryboardSamples(path.resolve('static/compliance/source'));
  const { createTrainingAgentRouter } = await import('../index.js');
  await clearTrainingState();
  const app = express();
  app.use(express.json({
    limit: '5mb',
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: string }).rawBody = buf.toString('utf8');
    },
  }));
  app.use('/api/training-agent', createTrainingAgentRouter({ disableRateLimit: true }));
  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/training-agent`;
  closeServer = () => new Promise(resolve => server.close(() => resolve()));
}, 60_000);

afterAll(async () => {
  await closeServer();
  await clearTrainingState();
  (await import('../state.js')).stopSessionCleanup();
});

// ── Tests ───────────────────────────────────────────────────────────

describe('training agent context echo', () => {
  describe.each(ROUTES)('%s route', route => {
    it('echoes context from every tool on a request its handler answers', async () => {
      const tools = await toolsFor(route);
      expect(tools.length).toBeGreaterThan(0);
      const unreached: string[] = [];
      for (const tool of tools) {
        let reached = 0;
        for (const request of candidateRequests(tool)) {
          const response = await callTool(routeUrl(route), tool.name, { ...request, context: CONTEXT });
          if (!reachedAdcpLayer(response)) continue;
          reached += 1;
          if (route !== 'legacy' && SDK_STRIPS_CONTEXT.has(tool.name)) {
            expect(
              echoedContexts(response).structured,
              `${route} ${tool.name} now echoes context; adcp-client#3666 is fixed here — remove it from SDK_STRIPS_CONTEXT.`,
            ).toBeUndefined();
            continue;
          }
          expectContextEchoed(response, `${route} ${tool.name}`);
        }
        if (reached === 0) unreached.push(tool.name);
      }
      // A tool listed here has no request that gets past input validation:
      // add a storyboard step for it, or a request this test can send.
      expect(unreached).toEqual([]);
    }, 240_000);

    it.each(VERSIONS)('echoes context on the error path at release %s', async version => {
      const tools = await toolsFor(route);
      const gap = new Set(SDK_INPUT_SCHEMA_CONTEXT_GAP[route]);
      const stillBroken: string[] = [];
      for (const tool of tools) {
        const response = await callTool(routeUrl(route), tool.name, {
          context: CONTEXT,
          ...(version !== undefined && { adcp_version: version }),
        });
        if (gap.has(tool.name)) {
          expect(
            isSdkInputSchemaRejection(response),
            `${route} ${tool.name} now answers at the AdCP layer; if it echoes context, adcp-client#3666 is fixed here — remove it from SDK_INPUT_SCHEMA_CONTEXT_GAP. ${JSON.stringify(response).slice(0, 400)}`,
          ).toBe(true);
          stillBroken.push(tool.name);
          continue;
        }
        expectContextEchoed(response, `${route} ${tool.name} @ ${version ?? 'default'}`);
      }
      // Every gap entry names a tool this route registers.
      expect(stillBroken.sort()).toEqual([...gap].sort());
    }, 120_000);
  });

  describe.each(['sales', 'legacy'] as const)('sync_accounts and get_media_buys on the %s route (adcp#8834)', route => {
    // The legacy monolith does not serve the opt-in preview.
    const versions = route === 'legacy'
      ? VERSIONS.filter(version => version !== TRAINING_AGENT_PREVIEW_ADCP_VERSION)
      : VERSIONS;
    it.each(versions)('echo each call\'s own context at release %s', async version => {
      const url = routeUrl(route);
      await toolsFor(route);
      const tag = `${route}-${version ?? 'default'}`.replace(/[^a-z0-9-]/gi, '-');
      const pin = version !== undefined ? { adcp_version: version } : {};
      const account = { brand: { domain: `${tag}.context-echo.example` }, operator: `${tag}.context-echo.example`, sandbox: true };
      const syncArgs = {
        ...pin,
        accounts: [{ ...account, billing: 'operator', payment_terms: 'net_30' }],
        idempotency_key: `context-echo-${tag}-${randomUUID()}`,
      };
      const contextFor = (step: string) => ({ ...CONTEXT, step });

      const created = await callTool(url, 'sync_accounts', { ...syncArgs, context: contextFor('created') });
      const createdRow = (created.result?.structuredContent?.accounts as Array<{ action?: string }> | undefined)?.[0];
      expect(createdRow?.action, JSON.stringify(created)).toBe('created');
      expect(created.result?.structuredContent?.context).toEqual(contextFor('created'));

      // A replay is served from the idempotency cache; the echo is this request's.
      const replayed = await callTool(url, 'sync_accounts', { ...syncArgs, context: contextFor('replayed') });
      expect(replayed.result?.structuredContent?.replayed, JSON.stringify(replayed)).toBe(true);
      expect(JSON.stringify(replayed.result?.structuredContent?.context)).toBe(JSON.stringify(contextFor('replayed')));
      for (const mirror of echoedContexts(replayed).mirrors) expect(mirror).toEqual(contextFor('replayed'));

      const updated = await callTool(url, 'sync_accounts', {
        ...syncArgs,
        idempotency_key: `context-echo-${tag}-${randomUUID()}`,
        context: contextFor('updated'),
      });
      expect(JSON.stringify(updated.result?.structuredContent?.context)).toBe(JSON.stringify(contextFor('updated')));

      const listed = await callTool(url, 'get_media_buys', { ...pin, account, context: contextFor('list') });
      expect(listed.result?.structuredContent?.media_buys, JSON.stringify(listed)).toEqual(expect.any(Array));
      expect(JSON.stringify(listed.result?.structuredContent?.context)).toBe(JSON.stringify(contextFor('list')));

      const lookedUp = await callTool(url, 'get_media_buys', {
        ...pin,
        account,
        media_buy_ids: ['context_echo_unknown_buy'],
        context: contextFor('lookup'),
      });
      expect(lookedUp.result?.structuredContent?.media_buys, JSON.stringify(lookedUp)).toEqual([]);
      expect(JSON.stringify(lookedUp.result?.structuredContent?.context)).toBe(JSON.stringify(contextFor('lookup')));
    }, 60_000);
  });
});
