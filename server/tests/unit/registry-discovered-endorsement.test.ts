/**
 * Pins the publisher-side endorsement signal for discovered agents.
 *
 * Closes #3547 (option C from issue body) / Problem 6 of #3538:
 *
 *   - Discovered agent whose `discovered_from.publisher_domain` is claimed
 *     by an AAO member (member_profiles.publishers[] with is_public=true)
 *     surfaces `endorsed_by_publisher_member` populated, member: null.
 *   - Discovered agent whose publisher_domain is NOT owned by any member
 *     never gets the field.
 *   - Registered agent never gets the field — it carries `member` instead.
 *   - When the same agent_url appears as both registered and discovered
 *     (e.g. a member registers an agent that's also in adagents.json),
 *     the registered row wins and no duplicate appears. This is the
 *     option-B collapse: existing behaviour, locked in by this test.
 *
 * Test seam: the FederatedIndexService instantiates `MemberDatabase` and
 * `FederatedIndexDatabase` in its constructor, so we mock the classes via
 * vi.mock. We exercise the merge logic in `listAllAgents` against
 * deterministic fixtures rather than spinning up a Postgres pool.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock both databases up-front. The FederatedIndexService constructor
// `new`s these directly; vi.mock replaces the modules before import.
const mockListProfiles = vi.fn();
const mockGetAllDiscoveredAgents = vi.fn();
const mockBulkGetFirstAuthForAgents = vi.fn();

vi.mock('../../src/db/member-db.js', () => ({
  MemberDatabase: class {
    listProfiles = mockListProfiles;
  },
}));

vi.mock('../../src/db/federated-index-db.js', () => ({
  FederatedIndexDatabase: class {
    getAllDiscoveredAgents = mockGetAllDiscoveredAgents;
    bulkGetFirstAuthForAgents = mockBulkGetFirstAuthForAgents;
  },
}));

// Imported AFTER vi.mock so the service picks up the mocks.
const { FederatedIndexService } = await import('../../src/federated-index.js');

describe('FederatedIndexService.listAllAgents — endorsed_by_publisher_member', () => {
  beforeEach(() => {
    mockListProfiles.mockReset();
    mockGetAllDiscoveredAgents.mockReset();
    mockBulkGetFirstAuthForAgents.mockReset();
  });

  function setupProfilesAndDiscovered(opts: {
    profiles: Array<{
      slug: string;
      display_name: string;
      publishers?: Array<{ domain: string; is_public: boolean }>;
      agents?: Array<{ url: string; visibility: string; type?: string; name?: string }>;
    }>;
    discoveredAgents: Array<{
      agent_url: string;
      source_type?: string;
      source_domain: string;
      name?: string;
      agent_type?: string;
      protocol?: string;
    }>;
    auths?: Map<string, { agent_url: string; publisher_domain: string; authorized_for?: string; source: 'adagents_json' | 'agent_claim' }>;
  }) {
    mockListProfiles.mockResolvedValue(
      opts.profiles.map((p) => ({
        ...p,
        publishers: p.publishers || [],
        agents: p.agents || [],
      })),
    );
    mockGetAllDiscoveredAgents.mockResolvedValue(opts.discoveredAgents);
    mockBulkGetFirstAuthForAgents.mockResolvedValue(opts.auths || new Map());
  }

  it('populates endorsed_by_publisher_member when publisher_domain is owned by a member', async () => {
    setupProfilesAndDiscovered({
      profiles: [
        {
          slug: 'mamamia',
          display_name: 'Mamamia',
          publishers: [{ domain: 'mamamia.com.au', is_public: true }],
        },
      ],
      discoveredAgents: [
        {
          agent_url: 'agent.mamamia.com.au',
          source_type: 'adagents_json',
          source_domain: 'mamamia.com.au',
          name: 'Mamamia Agent',
          agent_type: 'sales',
          protocol: 'mcp',
        },
      ],
    });

    const svc = new FederatedIndexService();
    const agents = await svc.listAllAgents();

    expect(agents).toHaveLength(1);
    const agent = agents[0];
    expect(agent.source).toBe('discovered');
    expect(agent.member).toBeUndefined();
    expect(agent.endorsed_by_publisher_member).toEqual({
      slug: 'mamamia',
      display_name: 'Mamamia',
      publisher_domain: 'mamamia.com.au',
    });
    expect(agent.discovered_from?.publisher_domain).toBe('mamamia.com.au');
  });

  it('omits endorsed_by_publisher_member when publisher_domain is not owned by any member', async () => {
    setupProfilesAndDiscovered({
      profiles: [
        {
          slug: 'someone-else',
          display_name: 'Someone Else',
          publishers: [{ domain: 'unrelated.com', is_public: true }],
        },
      ],
      discoveredAgents: [
        {
          agent_url: 'gatavocom.sales-agent.setupad.ai',
          source_type: 'adagents_json',
          source_domain: 'gatavo.com',
          name: 'Gatavo Sales',
          agent_type: 'sales',
          protocol: 'mcp',
        },
      ],
    });

    const svc = new FederatedIndexService();
    const agents = await svc.listAllAgents();

    expect(agents).toHaveLength(1);
    expect(agents[0].source).toBe('discovered');
    expect(agents[0].member).toBeUndefined();
    expect(agents[0].endorsed_by_publisher_member).toBeUndefined();
  });

  it('skips publishers with is_public=false (private endorsement is not a public signal)', async () => {
    setupProfilesAndDiscovered({
      profiles: [
        {
          slug: 'mamamia',
          display_name: 'Mamamia',
          publishers: [{ domain: 'mamamia.com.au', is_public: false }],
        },
      ],
      discoveredAgents: [
        {
          agent_url: 'agent.mamamia.com.au',
          source_type: 'adagents_json',
          source_domain: 'mamamia.com.au',
          name: 'Mamamia Agent',
          agent_type: 'sales',
          protocol: 'mcp',
        },
      ],
    });

    const svc = new FederatedIndexService();
    const agents = await svc.listAllAgents();

    expect(agents).toHaveLength(1);
    expect(agents[0].endorsed_by_publisher_member).toBeUndefined();
  });

  it('registered agents never carry endorsed_by_publisher_member', async () => {
    setupProfilesAndDiscovered({
      profiles: [
        {
          slug: 'acme',
          display_name: 'Acme',
          publishers: [{ domain: 'acme.example.com', is_public: true }],
          agents: [
            {
              url: 'https://agent.acme.example.com/mcp',
              visibility: 'public',
              type: 'sales',
              name: 'Acme Agent',
            },
          ],
        },
      ],
      discoveredAgents: [],
    });

    const svc = new FederatedIndexService();
    const agents = await svc.listAllAgents();

    expect(agents).toHaveLength(1);
    expect(agents[0].source).toBe('registered');
    expect(agents[0].member).toEqual({ slug: 'acme', display_name: 'Acme' });
    expect(agents[0].endorsed_by_publisher_member).toBeUndefined();
  });

  it('agent_url claimed by both registered + discovered collapses to registered (option B)', async () => {
    // The same agent_url that a member registered also appears in some
    // publisher's adagents.json. Registered row must win; no duplicate
    // discovered row with endorsed_by_publisher_member should appear.
    const sharedUrl = 'https://shared.agent.example.com/mcp';
    setupProfilesAndDiscovered({
      profiles: [
        {
          slug: 'acme',
          display_name: 'Acme',
          publishers: [{ domain: 'acme.example.com', is_public: true }],
          agents: [
            {
              url: sharedUrl,
              visibility: 'public',
              type: 'sales',
              name: 'Acme Agent',
            },
          ],
        },
        {
          // A different member also owns the publisher_domain that listed
          // this agent in its adagents.json.
          slug: 'pub-member',
          display_name: 'Pub Member',
          publishers: [{ domain: 'pub.example.com', is_public: true }],
        },
      ],
      discoveredAgents: [
        {
          agent_url: sharedUrl,
          source_type: 'adagents_json',
          source_domain: 'pub.example.com',
          name: 'Acme Agent',
          agent_type: 'sales',
          protocol: 'mcp',
        },
      ],
    });

    const svc = new FederatedIndexService();
    const agents = await svc.listAllAgents();

    // Only one row; registered wins.
    expect(agents).toHaveLength(1);
    expect(agents[0].source).toBe('registered');
    expect(agents[0].member).toEqual({ slug: 'acme', display_name: 'Acme' });
    expect(agents[0].endorsed_by_publisher_member).toBeUndefined();
  });

  it('uses authorization publisher_domain over discovered.source_domain when present', async () => {
    // First-auth from bulkGetFirstAuthForAgents takes precedence in
    // populating discovered_from.publisher_domain. The endorsement lookup
    // must follow that same domain so the surfaced linkage matches the
    // surfaced source.
    const url = 'https://multi.agent.example.com/mcp';
    setupProfilesAndDiscovered({
      profiles: [
        {
          slug: 'mamamia',
          display_name: 'Mamamia',
          publishers: [{ domain: 'mamamia.com.au', is_public: true }],
        },
      ],
      discoveredAgents: [
        {
          agent_url: url,
          source_type: 'adagents_json',
          source_domain: 'unrelated.example.com',
          name: 'Multi Agent',
          agent_type: 'sales',
          protocol: 'mcp',
        },
      ],
      auths: new Map([
        [
          url,
          {
            agent_url: url,
            publisher_domain: 'mamamia.com.au',
            authorized_for: 'sales',
            source: 'adagents_json',
          },
        ],
      ]),
    });

    const svc = new FederatedIndexService();
    const agents = await svc.listAllAgents();

    expect(agents).toHaveLength(1);
    expect(agents[0].discovered_from?.publisher_domain).toBe('mamamia.com.au');
    expect(agents[0].endorsed_by_publisher_member).toEqual({
      slug: 'mamamia',
      display_name: 'Mamamia',
      publisher_domain: 'mamamia.com.au',
    });
  });
});
