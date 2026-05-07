import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db/client.js', () => ({
  query: vi.fn(),
  isDatabaseInitialized: vi.fn(() => true),
}));

import type { PendingWebFlow } from '@adcp/sdk/auth';
import { AgentOAuthPendingFlowStore } from '../../src/routes/helpers/web-oauth-stores.js';
import { query } from '../../src/db/client.js';

const mockedQuery = vi.mocked(query);

const VERIFIER = 'test-verifier-' + 'abc'.repeat(20);
const ORG = 'org_123';

function makeFlow(overrides: Partial<PendingWebFlow> = {}): PendingWebFlow {
  const now = new Date('2026-05-07T10:00:00Z');
  const expiresAt = new Date('2026-05-07T10:10:00Z');
  return {
    state: 'state-' + Math.random().toString(36).slice(2),
    agentId: 'agent-ctx-1',
    agentUrl: 'https://agent.example.com/mcp',
    codeVerifier: VERIFIER,
    redirectUri: 'https://app.example.com/api/oauth/agent/callback',
    resource: 'https://agent.example.com/mcp',
    scope: 'mcp.read',
    authorizationServerUrl: 'https://agent.example.com',
    clientInformation: { client_id: 'client-1' },
    createdAt: now,
    expiresAt,
    carry: { organization_id: ORG, user_id: 'user-1' },
    ...overrides,
  };
}

describe('AgentOAuthPendingFlowStore', () => {
  let store: AgentOAuthPendingFlowStore;

  beforeEach(() => {
    store = new AgentOAuthPendingFlowStore();
    vi.clearAllMocks();
  });

  it('round-trips put → consume preserving the PKCE verifier', async () => {
    const flow = makeFlow();

    let captured: { state: string; data: string; expiresAt: Date } | undefined;
    mockedQuery.mockImplementationOnce(async (_sql: string, params?: unknown[]) => {
      captured = { state: params![0] as string, data: params![1] as string, expiresAt: params![2] as Date };
      return { rows: [], rowCount: 1, command: 'INSERT', oid: 0, fields: [] };
    });

    await store.put(flow);

    expect(captured).toBeDefined();
    expect(captured!.state).toBe(flow.state);
    // Stored payload must NOT contain the plaintext verifier — it should
    // be replaced by ciphertext + iv before INSERT.
    expect(captured!.data).not.toContain(VERIFIER);

    // Now exercise consume with the same payload the store inserted —
    // the round-trip proves encrypt/decrypt are wired against the same
    // salt (carry.organization_id) end-to-end.
    mockedQuery.mockImplementationOnce(async () => ({
      rows: [{ data: JSON.parse(captured!.data) }],
      rowCount: 1,
      command: 'DELETE',
      oid: 0,
      fields: [],
    }));

    const consumed = await store.consume(flow.state);
    expect(consumed).not.toBeNull();
    expect(consumed!.codeVerifier).toBe(VERIFIER);
    expect(consumed!.state).toBe(flow.state);
    expect(consumed!.agentId).toBe(flow.agentId);
    expect(consumed!.agentUrl).toBe(flow.agentUrl);
    expect(consumed!.resource).toBe(flow.resource);
    expect(consumed!.scope).toBe(flow.scope);
    expect(consumed!.carry).toEqual(flow.carry);
    expect(consumed!.expiresAt).toBeInstanceOf(Date);
    expect(consumed!.expiresAt.toISOString()).toBe(flow.expiresAt.toISOString());
  });

  it('put throws when carry.organization_id is missing — verifier salt is required', async () => {
    const flow = makeFlow({ carry: { user_id: 'user-1' } });
    await expect(store.put(flow)).rejects.toThrow(/organization_id/);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('put throws when carry is undefined entirely', async () => {
    const flow = makeFlow({ carry: undefined });
    await expect(store.put(flow)).rejects.toThrow(/organization_id/);
    expect(mockedQuery).not.toHaveBeenCalled();
  });

  it('consume returns null when no row matches', async () => {
    mockedQuery.mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'DELETE', oid: 0, fields: [] });
    const result = await store.consume('nonexistent-state');
    expect(result).toBeNull();
  });

  it('consume throws when the stored carry lacks organization_id (cannot derive salt)', async () => {
    // Synthesize a row that bypassed the put-side check (e.g., legacy data).
    // The decrypt call needs the salt that was used at encryption time.
    const stored = {
      state: 'legacy-state',
      agentId: 'agent-ctx-1',
      agentUrl: 'https://agent.example.com/mcp',
      codeVerifierEncrypted: 'fake:fake',
      codeVerifierIv: 'fake',
      redirectUri: 'https://app.example.com/api/oauth/agent/callback',
      authorizationServerUrl: 'https://agent.example.com',
      clientInformation: { client_id: 'client-1' },
      createdAt: '2026-05-07T10:00:00Z',
      expiresAt: '2026-05-07T10:10:00Z',
      // carry deliberately missing organization_id
      carry: { user_id: 'user-1' },
    };
    mockedQuery.mockResolvedValueOnce({
      rows: [{ data: stored }],
      rowCount: 1,
      command: 'DELETE',
      oid: 0,
      fields: [],
    });
    await expect(store.consume('legacy-state')).rejects.toThrow(/organization_id/);
  });
});
