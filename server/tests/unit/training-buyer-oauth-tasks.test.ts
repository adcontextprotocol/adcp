/** HTTP MCP regression: OAuth controller and SDK tasks share the trusted buyer scope. */
import express from 'express';
import { generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const authority = vi.hoisted(() => ({ key: undefined as unknown }));
vi.hoisted(() => {
  process.env.TRAINING_BUYER_OAUTH_ENABLED = 'true';
  process.env.TRAINING_BUYER_OAUTH_ISSUER = 'https://auth.example.com';
  process.env.TRAINING_BUYER_OAUTH_ORGANIZATION_ID = 'org_canary';
  delete process.env.TRAINING_REPORTING_GCS_CANARY_PRINCIPAL;
});
vi.mock('jose', async original => ({ ...await original<object>(), createRemoteJWKSet: () => async () => authority.key }));
vi.mock('../../src/db/user-authorization-snapshot-db.js', async original => ({
  ...await original<object>(),
  loadAuthorizationSnapshot: async (userId: string, organizationId: string) => ({
    authenticatedUserId: userId, canonicalUserId: userId, identityId: 'identity-oauth-task', bindingVersion: '1',
    selectedOrganizationId: organizationId, authorizationEpoch: '1',
    credential: { email: 'integrator@example.com', emailVerified: true },
    credentialGrant: null,
  }),
}));
vi.mock('../../src/auth/workos-client.js', () => ({ getPipesWorkos: () => ({ userManagement: {
  listOrganizationMemberships: async ({ userId, organizationId }: { userId: string; organizationId: string }) => ({
    data: [{ userId, organizationId, status: 'active', role: { slug: 'member' } }],
  }),
} }) }));
vi.mock('../../src/db/bans-db.js', () => ({ bansDb: { checkPlatformBanForUserAndOrg: async () => ({ banned: false }) } }));

import { createTrainingAgentRouter } from '../../src/training-agent/index.js';
import { clearAccountStore } from '../../src/training-agent/account-handlers.js';
import { clearForcedTaskCompletions } from '../../src/training-agent/comply-test-controller.js';
import { clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import { clearSessions, stopSessionCleanup } from '../../src/training-agent/state.js';

describe('OAuth sales task ownership over HTTP MCP', () => {
  let server: ReturnType<express.Express['listen']>;
  let endpoint: string;
  let keys: Awaited<ReturnType<typeof generateKeyPair>>;
  let rpcId = 0;
  async function token(organizationId: string, sid = 'app_consent_tasks') {
    return new SignJWT({ org_id: organizationId, client_id: 'client_shared_integrator', sid })
      .setProtectedHeader({ alg: 'RS256', kid: 'tasks' }).setIssuer('https://auth.example.com')
      .setAudience('https://test-agent.adcontextprotocol.org/sales/mcp').setSubject('user_integrator')
      .setIssuedAt().setExpirationTime('1h').sign(keys.privateKey);
  }
  async function rpc(credential: string, method: string, params: Record<string, unknown>) {
    const response = await fetch(endpoint, { method: 'POST', headers: {
      'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${credential}`,
    }, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
    const body = await response.json();
    expect(response.status, JSON.stringify(body)).toBe(200);
    expect(body.error, JSON.stringify(body)).toBeUndefined();
    return body.result;
  }
  async function tool(credential: string, name: string, args: Record<string, unknown>) {
    const result = await rpc(credential, 'tools/call', { name, arguments: args });
    expect(result.structuredContent, JSON.stringify(result)).toBeDefined();
    return result.structuredContent;
  }
  beforeAll(async () => {
    await clearSessions(); clearAccountStore(); clearIdempotencyCache(); clearForcedTaskCompletions();
    keys = await generateKeyPair('RS256'); authority.key = keys.publicKey;
    const app = express(); app.use(express.json()); app.use(createTrainingAgentRouter({ disableRateLimit: true }));
    server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing HTTP listener.');
    endpoint = `http://127.0.0.1:${address.port}/sales/mcp`;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    clearForcedTaskCompletions(); await clearSessions(); clearAccountStore(); clearIdempotencyCache(); stopSessionCleanup();
  });
  it('completes the caller task after token renewal and denies another organization using the same client', async () => {
    const ownToken = await token('org_integrator');
    const foreignToken = await token('org_other');
    for (const credential of [ownToken, foreignToken]) {
      await rpc(credential, 'initialize', { protocolVersion: '2025-03-26',
        clientInfo: { name: 'OAuth task regression', version: '1' }, capabilities: {} });
    }
    const account = { brand: { domain: 'oauth-tasks.example' }, operator: 'pinnacle-agency.example', sandbox: true };
    const taskId = 'task_oauth_integrator';
    const completion = { media_buy_id: 'mb_oauth_integrator', media_buy_status: 'pending_creatives',
      confirmed_at: '2026-10-14T12:00:00Z', revision: 1, currency: 'USD', packages: [{
        package_id: 'pkg_oauth_integrator', product_id: 'oauth_video', pricing_option_id: 'oauth_cpm', budget: 30_000, paused: false,
      }] };
    expect(await tool(ownToken, 'comply_test_controller', { account, scenario: 'force_create_media_buy_arm',
      params: { arm: 'submitted', task_id: taskId } })).toMatchObject({ success: true });
    expect(await tool(ownToken, 'create_media_buy', { account, brand: account.brand, start_time: 'asap',
      end_time: '2099-09-30T23:59:59Z', packages: [{ product_id: 'oauth_video', pricing_option_id: 'oauth_cpm', budget: 30_000 }],
      idempotency_key: 'oauth-tasks-create-0001' })).toMatchObject({ status: 'submitted', task_id: taskId });
    expect(await tool(ownToken, 'get_task_status', { account, task_id: taskId })).toMatchObject({ status: 'submitted', task_id: taskId });
    expect(await tool(foreignToken, 'comply_test_controller', { account, scenario: 'force_task_completion',
      params: { task_id: taskId, result: completion } })).toMatchObject({ success: false, error: 'NOT_FOUND' });
    // Renew the signed credential without changing the organization/client buyer identity.
    const renewedToken = await token('org_integrator', 'app_consent_renewed_tasks');
    expect(renewedToken).not.toBe(ownToken);
    expect(await tool(renewedToken, 'comply_test_controller', { account, scenario: 'force_task_completion',
      params: { task_id: taskId, result: completion } })).toMatchObject({ success: true, current_state: 'completed' });
    expect(await tool(renewedToken, 'get_task_status', { account, task_id: taskId, include_result: true }))
      .toMatchObject({ status: 'completed', task_id: taskId, result: completion });
  });
});
