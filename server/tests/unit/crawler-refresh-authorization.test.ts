import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCapabilityProfile } from '../../src/capabilities.js';
import type { AgentHealth, AgentStats } from '../../src/types.js';
import type { ComplianceRefreshAuthorizationGuard } from '../../src/services/compliance-refresh-authorization.js';

const mocks = vi.hoisted(() => ({ query: vi.fn(), getClient: vi.fn() }));
vi.mock('../../src/db/client.js', async () => ({
  ...await vi.importActual<typeof import('../../src/db/client.js')>('../../src/db/client.js'),
  query: mocks.query,
  getClient: mocks.getClient,
}));

import { CrawlerService } from '../../src/crawler.js';
import { AgentSnapshotDatabase } from '../../src/db/agent-snapshot-db.js';
import { FederatedIndexService } from '../../src/federated-index.js';

const agentUrl = 'https://agent.example.test/mcp';
const profile = {
  agent_url: agentUrl,
  protocol: 'mcp',
  discovered_tools: [],
  last_discovered: '2026-09-13T00:00:00.000Z',
} as unknown as AgentCapabilityProfile;
const health: AgentHealth = { online: true, checked_at: '2026-09-13T00:00:00.000Z' };
const revoked = Object.assign(new Error('Refresh authorization changed'), { code: 'authorization_revoked' });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function fixture(knownType = 'unknown') {
  let authorized = true;
  const client = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 1 }),
    release: vi.fn(),
  };
  mocks.getClient.mockResolvedValue(client);
  const authorization: ComplianceRefreshAuthorizationGuard = {
    checkpoint: vi.fn(async () => { if (!authorized) throw revoked; }),
    beforeWrite: vi.fn(async (transaction, url) => {
      if (!authorized) throw revoked;
      expect(url).toBe(agentUrl);
      await transaction.query('SELECT authorization_guard');
    }),
  };
  const capabilityDiscovery = {
    discoverCapabilities: vi.fn().mockResolvedValue(profile),
    inferTypeFromProfile: vi.fn().mockReturnValue('sales'),
  };
  const healthChecker = {
    checkHealth: vi.fn().mockResolvedValue(health),
    getStats: vi.fn().mockResolvedValue({}),
  };
  const federatedIndex = new FederatedIndexService();
  vi.spyOn(federatedIndex, 'listAllAgents').mockResolvedValue([
    { url: agentUrl, type: knownType, protocol: 'mcp', name: 'Fixture agent' } as never,
  ]);
  const crawler = Object.assign(Object.create(CrawlerService.prototype) as CrawlerService, {
    getPausedAgentUrls: vi.fn().mockResolvedValue(new Set()),
    capabilityDiscovery,
    healthChecker,
    federatedIndex,
    snapshotDb: new AgentSnapshotDatabase(),
  });
  return { crawler, authorization, client, capabilityDiscovery, healthChecker, revoke: () => { authorized = false; } };
}

describe('queued refresh authorization inside the crawler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('checks authorization before sending the first credential-bearing probe', async () => {
    const { crawler, authorization, capabilityDiscovery, revoke } = fixture();
    revoke();
    await expect(crawler.refreshSingleAgent(agentUrl, { authorization })).rejects.toBe(revoked);
    expect(capabilityDiscovery.discoverCapabilities).not.toHaveBeenCalled();
    expect(mocks.getClient).not.toHaveBeenCalled();
  });

  it('stops after revocation during capability discovery before health, stats, or writes', async () => {
    const { crawler, authorization, capabilityDiscovery, healthChecker, revoke } = fixture();
    const entered = deferred<void>();
    const discovery = deferred<AgentCapabilityProfile>();
    capabilityDiscovery.discoverCapabilities.mockImplementation(() => {
      entered.resolve();
      return discovery.promise;
    });
    const operation = crawler.refreshSingleAgent(agentUrl, { authorization });
    const rejected = expect(operation).rejects.toBe(revoked);
    await entered.promise;
    revoke();
    discovery.resolve(profile);
    await rejected;
    expect(healthChecker.checkHealth).not.toHaveBeenCalled();
    expect(healthChecker.getStats).not.toHaveBeenCalled();
    expect(mocks.getClient).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each(['health', 'stats'] as const)('stops canonical writes when authorization changes during %s', async (phase) => {
    const { crawler, authorization, healthChecker, revoke } = fixture();
    const entered = deferred<void>();
    const response = deferred<AgentHealth | AgentStats>();
    healthChecker[phase === 'health' ? 'checkHealth' : 'getStats'].mockImplementation(() => {
      entered.resolve();
      return response.promise;
    });
    const operation = crawler.refreshSingleAgent(agentUrl, { authorization });
    const rejected = expect(operation).rejects.toBe(revoked);
    await entered.promise;
    revoke();
    response.resolve(phase === 'health' ? health : {});
    await rejected;
    expect(mocks.getClient).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects revocation after the last checkpoint inside the write transaction', async () => {
    const { crawler, authorization, client } = fixture();
    vi.mocked(authorization.beforeWrite).mockRejectedValue(revoked);
    await expect(crawler.refreshSingleAgent(agentUrl, { authorization })).rejects.toBe(revoked);
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledOnce();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('rejects a capability profile for a different agent before further probes or writes', async () => {
    const { crawler, authorization, capabilityDiscovery, healthChecker } = fixture();
    capabilityDiscovery.discoverCapabilities.mockResolvedValue({ ...profile, agent_url: 'https://other.example.test/mcp' });
    await expect(crawler.refreshSingleAgent(agentUrl, { authorization })).rejects.toMatchObject({ code: 'probe_failed' });
    expect(healthChecker.checkHealth).not.toHaveBeenCalled();
    expect(healthChecker.getStats).not.toHaveBeenCalled();
    expect(mocks.getClient).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each(['unknown', 'creative'])('keeps snapshots and %s type handling on the guarded transaction', async (knownType) => {
    const { crawler, authorization, client } = fixture(knownType);
    await expect(crawler.refreshSingleAgent(agentUrl, { authorization })).resolves.toMatchObject({
      online: true,
      type_promoted: knownType === 'unknown',
    });
    expect(authorization.beforeWrite).toHaveBeenCalledExactlyOnceWith(client, agentUrl);
    const statements = client.query.mock.calls.map(([sql]) => sql as string);
    expect(statements[0]).toBe('BEGIN');
    expect(statements[1]).toBe('SELECT authorization_guard');
    expect(statements).toEqual(expect.arrayContaining([
      expect.stringContaining('INSERT INTO agent_capabilities_snapshot'),
      expect.stringContaining('INSERT INTO agent_health_snapshot'),
      expect.stringContaining(knownType === 'unknown' ? 'UPDATE discovered_agents' : 'INSERT INTO type_reclassification_log'),
    ]));
    expect(statements.at(-1)).toBe('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it.each(['agent_capabilities_snapshot', 'type_reclassification_log'])('does not swallow a guarded %s write failure', async (table) => {
    const { crawler, authorization, client } = fixture('creative');
    const failure = Object.assign(new Error('Transaction connection terminated'), { code: '08006' });
    client.query.mockImplementation(async (sql: string) => {
      if (sql.includes(`INSERT INTO ${table}`)) throw failure;
      return { rows: [], rowCount: 1 };
    });
    await expect(crawler.refreshSingleAgent(agentUrl, { authorization })).rejects.toBe(failure);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.query).not.toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });
});
