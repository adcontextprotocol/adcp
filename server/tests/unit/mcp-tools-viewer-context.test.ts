import { describe, it, expect, vi } from 'vitest';

const { mockProfiles, mockOrgs } = vi.hoisted(() => ({
  mockProfiles: [
    {
      id: 'p1',
      slug: 'acme',
      display_name: 'Acme',
      description: 'Ad tech',
      contact_email: 'hi@acme',
      contact_website: 'https://acme.example',
      is_public: true,
      created_at: new Date('2025-01-01'),
      resolved_brand: null,
      agents: [
        { url: 'https://public.acme', visibility: 'public', name: 'Public' },
        { url: 'https://members.acme', visibility: 'members_only', name: 'Members' },
        { url: 'https://private.acme', visibility: 'private', name: 'Private' },
      ],
    },
  ],
  mockOrgs: new Map<string, { membership_tier: string | null; subscription_status: string | null; subscription_amount: number | null; subscription_interval: string | null; subscription_price_lookup_key: string | null; is_personal: boolean }>([
    ['org_pro', { membership_tier: 'individual_professional', subscription_status: 'active', subscription_amount: 25000, subscription_interval: 'year', subscription_price_lookup_key: null, is_personal: true }],
    ['org_explorer', { membership_tier: 'individual_academic', subscription_status: 'active', subscription_amount: 5000, subscription_interval: 'year', subscription_price_lookup_key: null, is_personal: true }],
  ]),
}));

vi.mock('../../src/db/member-db.js', () => ({
  MemberDatabase: class {
    listProfiles = vi.fn().mockResolvedValue(mockProfiles);
    getPublicProfiles = vi.fn().mockResolvedValue(mockProfiles);
    getProfileBySlug = vi.fn().mockImplementation(async (slug: string) =>
      mockProfiles.find((p) => p.slug === slug) || null
    );
  },
}));

vi.mock('../../src/db/federated-index-db.js', () => ({
  FederatedIndexDatabase: class {
    getAllDiscoveredAgents = vi.fn().mockResolvedValue([]);
  },
}));

vi.mock('../../src/db/organization-db.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/db/organization-db.js')>(
    '../../src/db/organization-db.js'
  );
  return {
    ...actual,
    OrganizationDatabase: class {
      getOrganization = vi.fn().mockImplementation(async (orgId: string) =>
        mockOrgs.get(orgId) ?? null
      );
    },
  };
});

vi.mock('../../src/validator.js', () => ({ AgentValidator: class {} }));
vi.mock('../../src/federated-index.js', () => ({ FederatedIndexService: class {} }));
vi.mock('../../src/brand-manager.js', () => ({ BrandManager: class {} }));
vi.mock('../../src/adagents-manager.js', () => ({ AdAgentsManager: class {} }));

const { MCPToolHandler } = await import('../../src/mcp-tools.js');

function parseResource(result: Awaited<ReturnType<InstanceType<typeof MCPToolHandler>['handleToolCall']>>) {
  const first = result.content[0];
  if (first.type !== 'resource' || !first.resource) throw new Error('expected resource');
  return JSON.parse(first.resource.text);
}

describe('MCP list_agents viewer context', () => {
  it('returns only public agents for unauthenticated callers', async () => {
    const h = new MCPToolHandler();
    const result = await h.handleToolCall('list_agents', {}, undefined);
    const body = parseResource(result);
    const urls = body.agents.map((a: { url: string }) => a.url).sort();
    expect(urls).toEqual(['https://public.acme']);
  });

  it('returns only public agents for Explorer tier callers', async () => {
    const h = new MCPToolHandler();
    const result = await h.handleToolCall('list_agents', {}, {
      sub: 'user_1', orgId: 'org_explorer', isM2M: false, payload: {},
    });
    const body = parseResource(result);
    const urls = body.agents.map((a: { url: string }) => a.url).sort();
    expect(urls).toEqual(['https://public.acme']);
  });

  it('returns public + members_only for Professional tier callers', async () => {
    const h = new MCPToolHandler();
    const result = await h.handleToolCall('list_agents', {}, {
      sub: 'user_2', orgId: 'org_pro', isM2M: false, payload: {},
    });
    const body = parseResource(result);
    const urls = body.agents.map((a: { url: string }) => a.url).sort();
    expect(urls).toEqual(['https://members.acme', 'https://public.acme']);
  });

  it('never returns private agents even to Professional callers', async () => {
    const h = new MCPToolHandler();
    const result = await h.handleToolCall('list_agents', {}, {
      sub: 'user_2', orgId: 'org_pro', isM2M: false, payload: {},
    });
    const body = parseResource(result);
    const urls = body.agents.map((a: { url: string }) => a.url);
    expect(urls).not.toContain('https://private.acme');
  });
});

describe('MCP get_member viewer context', () => {
  it('hides members_only agents from Explorer callers', async () => {
    const h = new MCPToolHandler();
    const result = await h.handleToolCall('get_member', { slug: 'acme' }, {
      sub: 'user_e', orgId: 'org_explorer', isM2M: false, payload: {},
    });
    const body = parseResource(result);
    const urls = body.agents.map((a: { url: string }) => a.url).sort();
    expect(urls).toEqual(['https://public.acme']);
  });

  it('reveals members_only agents to Professional callers', async () => {
    const h = new MCPToolHandler();
    const result = await h.handleToolCall('get_member', { slug: 'acme' }, {
      sub: 'user_p', orgId: 'org_pro', isM2M: false, payload: {},
    });
    const body = parseResource(result);
    const urls = body.agents.map((a: { url: string }) => a.url).sort();
    expect(urls).toEqual(['https://members.acme', 'https://public.acme']);
  });
});
