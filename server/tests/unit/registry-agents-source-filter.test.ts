/**
 * Unit tests for the optional `?source=registered|discovered` filter on
 * `GET /api/registry/agents`.
 *
 * Pins:
 *   - Default behavior (no `source`) returns the merged list — exact same
 *     contract as before this change.
 *   - `source=registered` returns only registered agents.
 *   - `source=discovered` returns only discovered agents.
 *   - Invalid values return 400 with a descriptive error.
 *
 * The handler depends on a federated index (real implementation hits
 * Postgres) and a stack of database singletons. We mock those so the
 * test can run without infra and stays a pure handler-shape regression
 * guard. Heavy enrichment paths (`?health=true`, `?capabilities=true`,
 * etc.) are not exercised — the filter sits before enrichment, so the
 * default-path test is sufficient to lock in the contract.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';

const listAllAgentsMock = vi.fn();
const resolveCallerOrgIdMock = vi.fn().mockResolvedValue(null);
const getOrganizationMock = vi.fn().mockResolvedValue(null);

// Crawler, federated index, and the auth resolver are all that the
// `?source=` code path actually touches. Stub everything else with
// safe-looking no-ops so module load doesn't open a DB connection.
vi.mock('../../src/db/client.js', () => ({
  query: vi.fn().mockResolvedValue({ rows: [] }),
  initializeDatabase: vi.fn(),
  closeDatabase: vi.fn(),
}));

vi.mock('../../src/db/compliance-db.js', () => ({
  ComplianceDatabase: function ComplianceDatabase() { return {}; },
}));

vi.mock('../../src/db/agent-snapshot-db.js', () => ({
  AgentSnapshotDatabase: function AgentSnapshotDatabase() { return {}; },
}));

vi.mock('../../src/db/agent-context-db.js', () => ({
  AgentContextDatabase: function AgentContextDatabase() { return {}; },
}));

vi.mock('../../src/db/organization-db.js', () => ({
  OrganizationDatabase: function OrganizationDatabase() {
    return {
      getOrganization: (...args: unknown[]) => getOrganizationMock(...args),
    };
  },
  hasApiAccess: () => false,
  resolveMembershipTier: () => 'free',
}));

vi.mock('../../src/db/catalog-db.js', () => ({
  CatalogDatabase: function CatalogDatabase() { return {}; },
}));

vi.mock('../../src/db/property-check-db.js', () => ({
  PropertyCheckDatabase: function PropertyCheckDatabase() { return {}; },
}));

vi.mock('../../src/services/property-check.js', () => ({
  PropertyCheckService: function PropertyCheckService() { return {}; },
}));

vi.mock('../../src/services/bulk-property-check.js', () => ({
  BulkPropertyCheckService: function BulkPropertyCheckService() { return {}; },
}));

vi.mock('../../src/routes/helpers/resolve-caller-org.js', () => ({
  resolveCallerOrgId: (...args: unknown[]) => resolveCallerOrgIdMock(...args),
}));

vi.mock('../../src/middleware/rate-limit.js', () => ({
  bulkResolveRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  brandCreationRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  storyboardEvalRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  storyboardStepRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
  agentReadRateLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

const { createRegistryApiRouter } = await import('../../src/routes/registry-api.js');

type FederatedAgent = {
  url: string;
  name: string;
  type: string;
  protocol?: 'mcp' | 'a2a';
  source?: 'registered' | 'discovered';
  member?: { slug?: string; display_name?: string };
  discovered_from?: { publisher_domain?: string; authorized_for?: string };
  discovered_at?: string;
};

const FIXTURE_AGENTS: FederatedAgent[] = [
  {
    url: 'https://reg-a.example/mcp',
    name: 'Registered A',
    type: 'sales',
    protocol: 'mcp',
    source: 'registered',
    member: { slug: 'reg-a', display_name: 'Registered A Inc.' },
  },
  {
    url: 'https://reg-b.example/mcp',
    name: 'Registered B',
    type: 'creative',
    protocol: 'mcp',
    source: 'registered',
    member: { slug: 'reg-b', display_name: 'Registered B Inc.' },
  },
  {
    url: 'https://disc-a.example/mcp',
    name: 'Discovered A',
    type: 'sales',
    protocol: 'mcp',
    source: 'discovered',
    discovered_from: { publisher_domain: 'pub-a.example' },
  },
];

function buildApp() {
  const fakeFederatedIndex = {
    listAllAgents: (...args: unknown[]) => listAllAgentsMock(...args),
  };
  const fakeCrawler = {
    getFederatedIndex: () => fakeFederatedIndex,
  };

  const router = createRegistryApiRouter({
    brandManager: {} as never,
    brandDb: {} as never,
    propertyDb: {} as never,
    adagentsManager: {} as never,
    healthChecker: {} as never,
    crawler: fakeCrawler as never,
    capabilityDiscovery: {} as never,
    registryRequestsDb: {
      trackRequest: vi.fn().mockResolvedValue(undefined),
      markResolved: vi.fn().mockResolvedValue(false),
    },
    requireAuth: (_req, _res, next) => next(),
    optionalAuth: (_req, _res, next) => next(),
  });

  const app = express();
  app.use('/api', router);
  return app;
}

describe('GET /api/registry/agents — ?source filter', () => {
  beforeEach(() => {
    listAllAgentsMock.mockReset();
    resolveCallerOrgIdMock.mockReset();
    resolveCallerOrgIdMock.mockResolvedValue(null);
    getOrganizationMock.mockReset();
    getOrganizationMock.mockResolvedValue(null);
    listAllAgentsMock.mockResolvedValue([...FIXTURE_AGENTS]);
  });

  it('returns the merged list when no source param is provided (default behavior preserved)', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/registry/agents');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.agents).toHaveLength(3);
    expect(res.body.sources).toEqual({ registered: 2, discovered: 1 });

    const sources = res.body.agents.map((a: { source: string }) => a.source).sort();
    expect(sources).toEqual(['discovered', 'registered', 'registered']);
  });

  it('returns only registered agents when source=registered', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/registry/agents?source=registered');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.agents).toHaveLength(2);
    expect(res.body.agents.every((a: { source: string }) => a.source === 'registered')).toBe(true);
    expect(res.body.sources).toEqual({ registered: 2, discovered: 0 });
  });

  it('returns only discovered agents when source=discovered', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/registry/agents?source=discovered');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0].source).toBe('discovered');
    expect(res.body.agents[0].url).toBe('https://disc-a.example/mcp');
    expect(res.body.sources).toEqual({ registered: 0, discovered: 1 });
  });

  it('returns 400 with a descriptive error for invalid source values', async () => {
    const app = buildApp();
    const res = await request(app).get('/api/registry/agents?source=foo');

    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error).toMatch(/source/i);
    // Mustn't have run the federated query when validation rejected up front.
    expect(listAllAgentsMock).not.toHaveBeenCalled();
  });

  it('rejects empty-string-but-present source values strictly (treated as omitted, not invalid)', async () => {
    // Empty string means "param key was passed with no value". The handler
    // treats that as "not provided" — same outcome as omitting the param.
    // Locked in so a future strict-parser rewrite has to make a deliberate
    // decision here.
    const app = buildApp();
    const res = await request(app).get('/api/registry/agents?source=');

    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
  });
});
