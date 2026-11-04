import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { TrainingContext } from '../../src/training-agent/types.js';
import { clearAccountStore } from '../../src/training-agent/account-handlers.js';
import { clearSessions, stopSessionCleanup } from '../../src/training-agent/state.js';

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { customToolFor } from '../../src/training-agent/tenants/custom-tool-helper.js';
import { clearIdempotencyCache } from '../../src/training-agent/idempotency.js';

process.env.PUBLIC_TEST_AGENT_TOKEN = 'test-token';

async function bootServer(options: { storyboardCompat?: TrainingContext['storyboardCompat'] } = {}): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const { createTrainingAgentRouter } = await import('../../src/training-agent/index.js');
  const app = express();
  app.use(express.json({
    limit: '5mb',
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: string }).rawBody = buf.toString('utf8');
    },
  }));
  app.use('/api/training-agent', createTrainingAgentRouter(options));
  const srv = http.createServer(app);
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/api/training-agent`,
    close: () => new Promise(r => srv.close(() => r())),
  };
}

function stageLatestThreeZeroSchemaBundle(): void {
  const schemasRoot = path.resolve('dist/schemas');
  const latest = fs.readdirSync(schemasRoot)
    .filter(name => /^3\.0\.\d+$/.test(name))
    .sort((a, b) => {
      const av = a.split('.').map(Number);
      const bv = b.split('.').map(Number);
      for (let i = 0; i < 3; i += 1) {
        if (av[i] !== bv[i]) return av[i] - bv[i];
      }
      return 0;
    })
    .at(-1);
  if (!latest) throw new Error('No dist/schemas/3.0.x bundle found');
  execFileSync('bash', ['scripts/stage-sdk-schema-bundle.sh', path.join(schemasRoot, latest), '3.0'], {
    stdio: 'ignore',
  });
}

async function initializeTenant(url: string, token = 'test-token'): Promise<void> {
  await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', clientInfo: { name: 'x', version: '1' }, capabilities: {} },
    }),
  });
}

async function callTenantTool(url: string, id: number, name: string, args: Record<string, unknown>, token = 'test-token'): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  });
  return response.json() as Promise<Record<string, unknown>>;
}

describe('3.1 sales account fixture prerequisites', () => {
  beforeEach(() => { clearSessions(); clearAccountStore(); });
  afterEach(() => { clearSessions(); clearAccountStore(); stopSessionCleanup(); });

  it.each([false, true])('dispatches sales account fixtures over MCP (pre-provisioned: %s)', async (warm) => {
    const { baseUrl, close } = await bootServer();
    try {
      const url = `${baseUrl}/sales/mcp`;
      await initializeTenant(url);
      const fixture = {
        brand: { domain: 'acmeoutdoor.example' }, operator: 'pinnacle-agency.example',
        billing: 'operator', status: 'active', sandbox: true,
      };
      const args = {
        scenario: 'seed_account', account: { sandbox: true },
        params: { account_id: 'acct_acmeoutdoor_pinnacle_sandbox', fixture },
        context: { correlation_id: 'seed-3-1-account' },
      };
      const data = (body: Record<string, unknown>) => (body.result as { structuredContent?: Record<string, unknown> })?.structuredContent;
      if (warm) {
        const provisioned = data(await callTenantTool(url, 20, 'sync_accounts', {
          accounts: [fixture], idempotency_key: 'warm-account-before-fixture',
        }));
        expect(provisioned?.accounts).toEqual(expect.arrayContaining([expect.objectContaining({
          brand: fixture.brand, status: 'active',
        })]));
      }
      const before = data(await callTenantTool(url, 2, 'list_accounts', { sandbox: true }));
      expect(JSON.stringify(before)).not.toContain('acct_acmeoutdoor_pinnacle_sandbox');
      for (const id of [3, 4]) {
        const seeded = data(await callTenantTool(url, id, 'comply_test_controller', args));
        expect(seeded?.success).toBe(true);
        expect(seeded?.context).toEqual(args.context);
      }
      const listed = data(await callTenantTool(url, 5, 'list_accounts', { sandbox: true }));
      expect(listed?.accounts).toEqual(expect.arrayContaining([expect.objectContaining({
        account_id: args.params.account_id, brand: fixture.brand, operator: fixture.operator, status: 'active',
      })]));
      const rejected = await callTenantTool(url, 6, 'comply_test_controller', {
        ...args, params: { ...args.params, fixture: { ...fixture, status: 'suspended' } },
      });
      expect(data(rejected)).toMatchObject({ status: 'failed', success: false, error: 'INVALID_PARAMS' });
      expect(data(rejected)?.error_detail).toContain('diverges from the previously seeded fixture');
      const unchanged = data(await callTenantTool(url, 7, 'list_accounts', { sandbox: true }));
      expect(unchanged?.accounts).toEqual(expect.arrayContaining([expect.objectContaining({
        account_id: args.params.account_id, status: 'active',
      })]));
    } finally { await close(); }
  });

  it('isolates divergent account seed replays between authenticated callers', async () => {
    const { baseUrl, close } = await bootServer();
    try {
      const url = `${baseUrl}/sales/mcp`;
      const tokens = ['demo-acme-outdoor-v201', 'demo-acme-outdoor-v202'];
      for (const token of tokens) await initializeTenant(url, token);
      const data = (body: Record<string, unknown>) => (body.result as { structuredContent?: Record<string, unknown> })?.structuredContent;
      const seed = (status: string) => ({
        scenario: 'seed_account', account: { sandbox: true },
        params: { account_id: 'acct_caller_isolation', fixture: {
          brand: { domain: 'caller-isolation.example' }, operator: 'pinnacle-agency.example',
          billing: 'operator', status, sandbox: true,
        } },
        context: { correlation_id: 'shared-seed-correlation' },
        // Spoofing this private field must not select the other caller's cache.
        __training_principal: 'untrusted-caller-value',
      });
      expect(data(await callTenantTool(url, 2, 'comply_test_controller', seed('suspended'), tokens[0]))?.success).toBe(true);
      expect(data(await callTenantTool(url, 3, 'comply_test_controller', seed('active'), tokens[1]))?.success).toBe(true);
      for (const [index, status] of ['suspended', 'active'].entries()) {
        const listed = data(await callTenantTool(url, 4 + index, 'list_accounts', { sandbox: true }, tokens[index]));
        expect(listed?.accounts).toEqual(expect.arrayContaining([expect.objectContaining({
          account_id: 'acct_caller_isolation', status,
        })]));
      }
      const conflict = data(await callTenantTool(url, 6, 'comply_test_controller', seed('suspended'), tokens[1]));
      expect(conflict).toMatchObject({ success: false, error: 'INVALID_PARAMS' });
      expect(conflict?.error_detail).toContain('diverges from the previously seeded fixture');
    } finally { await close(); }
  });

  it('keeps account seeding unavailable on the frozen 3.0 sales tenant', async () => {
    stageLatestThreeZeroSchemaBundle();
    const { baseUrl, close } = await bootServer({ storyboardCompat: { version: '3.0' } });
    try {
      const url = `${baseUrl}/sales/mcp`;
      await initializeTenant(url);
      const result = await callTenantTool(url, 2, 'comply_test_controller', {
        scenario: 'seed_account', account: { sandbox: true },
        params: { account_id: 'unavailable', fixture: {
          brand: { domain: 'acmeoutdoor.example' }, operator: 'pinnacle-agency.example', sandbox: true,
        } },
      });
      expect(JSON.stringify(result)).toContain('UNKNOWN_SCENARIO');
    } finally { await close(); }
  });

});

// Custom-tool responses bypass the framework response builders. Exercise the
// registered sales route so domain-only account rows cannot hide a missing task
// envelope status, including a successful exact filter that returns no accounts.
function selectedAccountListValidator() {
  const version = '3.1.31';
  const root = path.resolve('dist/schemas', version);
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  const loaded = new Set<string>();
  function add(relative: string): void {
    if (loaded.has(relative)) return;
    const schema = JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
    loaded.add(relative);
    function refs(value: unknown): void {
      if (!value || typeof value !== 'object') return;
      const record = value as Record<string, unknown>;
      if (typeof record.$ref === 'string' && !record.$ref.startsWith('#')) {
        const prefix = `/schemas/${version}/`;
        if (!record.$ref.startsWith(prefix)) throw new Error(`Unexpected selected schema reference: ${record.$ref}`);
        add(record.$ref.slice(prefix.length).split('#')[0]);
      }
      for (const item of Object.values(record)) refs(item);
    }
    refs(schema);
    ajv.addSchema(schema);
  }
  add('account/list-accounts-response.json');
  const id = `/schemas/${version}/account/list-accounts-response.json`;
  const validate = ajv.getSchema(id);
  if (!validate) throw new Error(`Missing selected response validator: ${id}`);
  expect((validate.schema as { $id?: string }).$id).toBe(id);
  return { validate, ajv };
}

function consistentStructuredResult(rpc: Record<string, unknown>): Record<string, unknown> {
  expect(rpc.error).toBeUndefined();
  const result = rpc.result as { isError?: boolean; content: Array<{ type: string; text?: string }>; structuredContent: Record<string, unknown> };
  expect(result.isError).not.toBe(true);
  const text = result.content.find(item => item.type === 'text')?.text;
  expect(text).toBeDefined();
  expect(JSON.parse(text!)).toEqual(result.structuredContent);
  return result.structuredContent;
}

describe('registered sales list_accounts task envelopes', () => {
  beforeEach(async () => { await clearSessions(); clearAccountStore(); });
  afterEach(async () => { await clearSessions(); clearAccountStore(); stopSessionCleanup(); });

  it.each([true, false])('returns a selected-3.1 completed envelope for exact account matching=%s', async (matching) => {
    const { baseUrl, close } = await bootServer();
    try {
      const url = `${baseUrl}/sales/mcp`;
      await initializeTenant(url);
      const target = { brand: { domain: 'test.example' }, operator: 'test.example', sandbox: true };
      const unrelated = { brand: { domain: 'acmeoutdoor.example' }, operator: 'pinnacle-agency.example', sandbox: true };
      const syncRpc = await callTenantTool(url, 30, 'sync_accounts', {
        accounts: [unrelated, target].map(account => ({ ...account, billing: 'operator' })),
        idempotency_key: `list-envelope-${matching ? 'matching' : 'empty'}-accounts`,
      });
      expect(syncRpc.error).toBeUndefined();
      const synced = (syncRpc.result as { structuredContent: Record<string, unknown> }).structuredContent;
      const accounts = synced.accounts as Array<{ account_id: string; brand: { domain: string }; operator: string }>;
      const targetId = accounts.find(account => account.brand.domain === target.brand.domain)?.account_id;
      expect(targetId).toEqual(expect.any(String));
      const context = { correlation_id: `list-envelope-${matching ? 'matching' : 'empty'}` };
      const account = matching ? target : { ...target, brand: { domain: 'absent.example' } };
      const wire = consistentStructuredResult(await callTenantTool(url, 31, 'list_accounts', {
        account, context, pagination: { max_results: 10 },
      }));
      expect(wire.status).toBe('completed');
      expect(wire.context).toEqual(context);
      expect(wire.pagination).toMatchObject({ has_more: false, total_count: matching ? 1 : 0 });
      if (matching) {
        expect(wire.accounts).toEqual([expect.objectContaining({
          account_id: targetId, brand: target.brand, operator: target.operator, sandbox: true, status: 'active',
        })]);
      } else expect(wire.accounts).toEqual([]);
      const { validate, ajv } = selectedAccountListValidator();
      expect(validate(wire), ajv.errorsText(validate.errors)).toBe(true);
    } finally { await close(); }
  });
});

// These preservation checks use real MCP registration/dispatch with the official
// in-memory transport; they do not call the serializer's private function or mock
// wrapEnvelope. The HTTP cases above cover the actual tenant adapter seam.
async function withRegisteredAdapter(
  name: string,
  handler: Parameters<typeof customToolFor>[3],
  options: Parameters<typeof customToolFor>[4],
  exercise: (client: Client) => Promise<void>,
): Promise<void> {
  const schema = { context: z.unknown().optional(), idempotency_key: z.string().optional() };
  const tool = customToolFor(name, 'Custom adapter preservation probe', schema, handler, options);
  const server = new McpServer({ name: 'custom-adapter-preservation', version: '1.0.0' });
  server.registerTool(name, { description: tool.description, inputSchema: schema }, async (args, extra) =>
    await tool.handler(args, extra) as CallToolResult);
  const client = new Client({ name: 'custom-adapter-preservation', version: '1.0.0' }, { capabilities: {} });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await exercise(client);
  } finally { await client.close(); await server.close(); }
}

async function adapterCall(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  const text = content.find(item => item.type === 'text')?.text;
  expect(text).toBeDefined();
  const body = result.structuredContent as Record<string, unknown>;
  expect(JSON.parse(text!)).toEqual(body);
  return { result, body };
}

describe('custom-tool envelope semantic preservation', () => {
  beforeEach(async () => { await clearIdempotencyCache(); await clearSessions(); });
  afterEach(async () => { await clearIdempotencyCache(); await clearSessions(); stopSessionCleanup(); });

  it.each(['submitted', 'working', 'active'])('preserves explicit status %s and leaves handler data unchanged', async (status) => {
    const payload = Object.freeze({ status, task_id: 'adapter_task', marker: 'original' });
    await withRegisteredAdapter('explicit_status_probe', () => payload, {}, async client => {
      const { body } = await adapterCall(client, 'explicit_status_probe', { context: { correlation_id: 'explicit-status' } });
      expect(body).toMatchObject(payload);
      expect(payload).toEqual({ status, task_id: 'adapter_task', marker: 'original' });
    });
  });

  it.each(['list_products', 'decline_proposals', 'list_collections', 'list_proposals'])('keeps %s success roots status-free', async name => {
    const payload = Object.freeze({ items: [] });
    await withRegisteredAdapter(name, () => payload, {}, async client => {
      const { body } = await adapterCall(client, name, {});
      expect(body).not.toHaveProperty('status');
      expect(body.items).toEqual([]);
      expect(payload).not.toHaveProperty('status');
    });
  });

  it('retains fatal errors and their detail without promoting them to completed', async () => {
    const error = { code: 'INVALID_REQUEST', message: 'Controlled refusal', field: 'account', details: { reason: 'fixture' }, recovery: 'correctable' };
    await withRegisteredAdapter('fatal_error_probe', () => ({ errors: [error] }), {}, async client => {
      const { result, body } = await adapterCall(client, 'fatal_error_probe', { context: { correlation_id: 'fatal-error' } });
      expect(result.isError).toBe(true);
      expect(body.adcp_error).toEqual(error);
      expect(body.status).not.toBe('completed');
      expect(body.context).toEqual({ correlation_id: 'fatal-error' });
    });
  });

  it('keeps advisory errors as completed data when payloadErrorsAsSuccess is enabled', async () => {
    const advisory = { code: 'PARTIAL_SUCCESS', message: 'Controlled advisory' };
    await withRegisteredAdapter('advisory_probe', () => ({ accepted: 1, errors: [advisory] }), { payloadErrorsAsSuccess: true }, async client => {
      const { result, body } = await adapterCall(client, 'advisory_probe', {});
      expect(result.isError).not.toBe(true);
      expect(body).toMatchObject({ status: 'completed', accepted: 1, errors: [advisory] });
      expect(body).not.toHaveProperty('adcp_error');
    });
  });

  it.each([undefined, 'submitted'])('preserves idempotency replay and fresh context for status=%s', async status => {
    let calls = 0;
    await withRegisteredAdapter('replay_probe', () => { calls += 1; return { ...(status === undefined ? {} : { status }), task_id: 'cached_task' }; }, { enforceIdempotency: true }, async client => {
      const key = `adapter-replay-${status ?? 'default'}-123456`;
      const first = await adapterCall(client, 'replay_probe', { idempotency_key: key, context: { correlation_id: 'initial' } });
      const second = await adapterCall(client, 'replay_probe', { idempotency_key: key, context: { correlation_id: 'retry' } });
      expect(calls).toBe(1);
      expect(first.body.status).toBe(status ?? 'completed');
      expect(second.body.status).toBe(status ?? 'completed');
      expect(first.body.replayed).not.toBe(true);
      expect(second.body.replayed).toBe(true);
      expect(second.body.task_id).toBe(first.body.task_id);
      expect(second.body.context).toEqual({ correlation_id: 'retry' });
    });
  });
});
