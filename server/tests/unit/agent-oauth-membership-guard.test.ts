import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingWebFlow, PendingWebFlowStore } from '@adcp/sdk/auth';

const workosMocks = vi.hoisted(() => ({
  listOrganizationMemberships: vi.fn(),
}));

vi.mock('../../src/auth/workos-client.js', () => ({
  getWorkos: () => ({
    userManagement: {
      listOrganizationMemberships: workosMocks.listOrganizationMemberships,
    },
  }),
}));

vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

import { createMembershipGuardedPendingFlowStore } from '../../src/routes/agent-oauth.js';

function makeFlow(overrides: Partial<PendingWebFlow> = {}): PendingWebFlow {
  return {
    state: 'state_123',
    agentId: 'agent_ctx_123',
    agentUrl: 'https://agent.example.com/mcp',
    codeVerifier: 'verifier',
    redirectUri: 'https://app.example.com/api/oauth/agent/callback',
    authorizationServerUrl: 'https://auth.example.com',
    clientInformation: { client_id: 'client_123' } as any,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    expiresAt: new Date('2026-01-01T00:10:00Z'),
    carry: { organization_id: 'org_123' },
    ...overrides,
  };
}

function makeStore(flow: PendingWebFlow | null): PendingWebFlowStore {
  return {
    put: vi.fn(),
    consume: vi.fn().mockResolvedValue(flow),
  };
}

describe('createMembershipGuardedPendingFlowStore', () => {
  beforeEach(() => {
    workosMocks.listOrganizationMemberships.mockReset();
  });

  it('returns the consumed flow when the callback user is still active in the flow org', async () => {
    const flow = makeFlow();
    const store = makeStore(flow);
    workosMocks.listOrganizationMemberships.mockResolvedValueOnce({
      data: [{ userId: 'user_123', organizationId: 'org_123', status: 'active' }],
    });

    const guarded = createMembershipGuardedPendingFlowStore(store, 'user_123');

    await expect(guarded.consume('state_123')).resolves.toBe(flow);
    expect(workosMocks.listOrganizationMemberships).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user_123',
      organizationId: 'org_123',
      statuses: ['active'],
    }));
  });

  it('returns null before token exchange when the callback user is not active in the flow org', async () => {
    const store = makeStore(makeFlow());
    workosMocks.listOrganizationMemberships.mockResolvedValueOnce({ data: [] });

    const guarded = createMembershipGuardedPendingFlowStore(store, 'user_123');

    await expect(guarded.consume('state_123')).resolves.toBeNull();
  });

  it('rejects before token exchange when WorkOS membership verification fails', async () => {
    const store = makeStore(makeFlow());
    workosMocks.listOrganizationMemberships.mockRejectedValueOnce(new Error('workos unavailable'));

    const guarded = createMembershipGuardedPendingFlowStore(store, 'user_123');

    await expect(guarded.consume('state_123')).rejects.toThrow('workos unavailable');
  });
});
