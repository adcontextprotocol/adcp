import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import http from 'node:http';
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

describe('training controller seed replay ownership', () => {
  beforeEach(() => { clearSessions(); clearAccountStore(); });
  afterEach(() => { clearSessions(); clearAccountStore(); stopSessionCleanup(); });

  it.each(['sales', 'signals', 'governance', 'creative', 'creative-builder'])('isolates authenticated caller seed replays on %s', async (tenant) => {
    const { baseUrl, close } = await bootServer();
    try {
      const url = `${baseUrl}/${tenant}/mcp`;
      const accountsUrl = `${baseUrl}/sales/mcp`;
      const tokens = ['demo-acme-outdoor-v201', 'demo-acme-outdoor-v202'];
      for (const token of tokens) {
        await initializeTenant(url, token);
        if (tenant !== 'sales') await initializeTenant(accountsUrl, token);
      }
      const data = (body: Record<string, unknown>) => (body.result as { structuredContent?: Record<string, unknown> })?.structuredContent;
      const seed = (status: string) => ({
        scenario: 'seed_account', account: { sandbox: true },
        params: { account_id: 'acct_caller_isolation', fixture: {
          brand: { domain: 'caller-isolation.example' }, operator: 'pinnacle-agency.example',
          billing: 'operator', status, sandbox: true,
        } },
        context: { correlation_id: 'shared-seed-correlation', session_id: 'untrusted-session' },
        // Spoofing this private field must not select the other caller's cache.
        __training_principal: 'untrusted-caller-value',
        __training_task_owner_scope: 'untrusted-task-scope',
      });
      expect(data(await callTenantTool(url, 2, 'comply_test_controller', seed('suspended'), tokens[0]))?.success).toBe(true);
      expect(data(await callTenantTool(url, 3, 'comply_test_controller', seed('active'), tokens[1]))?.success).toBe(true);
      for (const [index, status] of ['suspended', 'active'].entries()) {
        const listed = data(await callTenantTool(accountsUrl, 4 + index, 'list_accounts', { sandbox: true }, tokens[index]));
        const ownedAccounts = (listed?.accounts as Record<string, unknown>[])
          .filter(account => account.account_id === 'acct_caller_isolation');
        expect(ownedAccounts).toEqual([expect.objectContaining({
          account_id: 'acct_caller_isolation', status,
        })]);
      }
      expect(data(await callTenantTool(url, 9, 'comply_test_controller', seed('active'), tokens[1]))?.success).toBe(true);
      const conflict = data(await callTenantTool(url, 6, 'comply_test_controller', seed('suspended'), tokens[1]));
      expect(conflict).toMatchObject({ success: false, error: 'INVALID_PARAMS' });
      expect(conflict?.error_detail).toContain('diverges from the previously seeded fixture');
      const afterConflict = data(await callTenantTool(accountsUrl, 10, 'list_accounts', { sandbox: true }, tokens[1]));
      expect((afterConflict?.accounts as Record<string, unknown>[])
        .filter(account => account.account_id === 'acct_caller_isolation'))
        .toEqual([expect.objectContaining({ account_id: 'acct_caller_isolation', status: 'active' })]);
    } finally { await close(); }
  });

});
