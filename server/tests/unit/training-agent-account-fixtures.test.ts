import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { TrainingContext } from '../../src/training-agent/types.js';
import { clearAccountStore } from '../../src/training-agent/account-handlers.js';
import { clearSessions, stopSessionCleanup } from '../../src/training-agent/state.js';

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
