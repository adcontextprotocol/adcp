import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { conformanceSessions } from '../../src/conformance/session-store.js';
import type { ConformanceWSServerTransport } from '../../src/conformance/ws-server-transport.js';

function fakeTransport(orgId: string): ConformanceWSServerTransport {
  return {
    orgId,
    sessionId: `conformance-${orgId}-test`,
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConformanceWSServerTransport;
}

function fakeClient(): Client {
  return {} as unknown as Client;
}

describe('ConformanceSessionStore', () => {
  beforeEach(async () => {
    await conformanceSessions.closeAll();
  });

  it('registers and returns a session by orgId', () => {
    const transport = fakeTransport('org_a');
    conformanceSessions.register({
      orgId: 'org_a',
      transport,
      mcpClient: fakeClient(),
      connectedAt: Date.now(),
    });
    expect(conformanceSessions.get('org_a')?.orgId).toBe('org_a');
    expect(conformanceSessions.size()).toBe(1);
  });

  it('returns undefined for an unknown org', () => {
    expect(conformanceSessions.get('org_unknown')).toBeUndefined();
  });

  it('displaces a prior session for the same org and closes the prior transport', () => {
    const priorTransport = fakeTransport('org_a');
    const newTransport = fakeTransport('org_a');

    conformanceSessions.register({
      orgId: 'org_a',
      transport: priorTransport,
      mcpClient: fakeClient(),
      connectedAt: 100,
    });
    conformanceSessions.register({
      orgId: 'org_a',
      transport: newTransport,
      mcpClient: fakeClient(),
      connectedAt: 200,
    });

    expect(priorTransport.close).toHaveBeenCalled();
    expect(conformanceSessions.get('org_a')?.connectedAt).toBe(200);
    expect(conformanceSessions.size()).toBe(1);
  });

  it('removes a session by orgId', () => {
    conformanceSessions.register({
      orgId: 'org_a',
      transport: fakeTransport('org_a'),
      mcpClient: fakeClient(),
      connectedAt: Date.now(),
    });
    conformanceSessions.remove('org_a');
    expect(conformanceSessions.get('org_a')).toBeUndefined();
  });

  it('lists all sessions with metadata only', () => {
    conformanceSessions.register({
      orgId: 'org_a',
      transport: fakeTransport('org_a'),
      mcpClient: fakeClient(),
      connectedAt: 100,
    });
    conformanceSessions.register({
      orgId: 'org_b',
      transport: fakeTransport('org_b'),
      mcpClient: fakeClient(),
      connectedAt: 200,
    });
    const list = conformanceSessions.list();
    expect(list).toHaveLength(2);
    const orgs = list.map((s) => s.orgId).sort();
    expect(orgs).toEqual(['org_a', 'org_b']);
  });

  it('closeAll empties the store and closes every transport', async () => {
    const tA = fakeTransport('org_a');
    const tB = fakeTransport('org_b');
    conformanceSessions.register({
      orgId: 'org_a',
      transport: tA,
      mcpClient: fakeClient(),
      connectedAt: 100,
    });
    conformanceSessions.register({
      orgId: 'org_b',
      transport: tB,
      mcpClient: fakeClient(),
      connectedAt: 200,
    });
    await conformanceSessions.closeAll();
    expect(conformanceSessions.size()).toBe(0);
    expect(tA.close).toHaveBeenCalled();
    expect(tB.close).toHaveBeenCalled();
  });
});
