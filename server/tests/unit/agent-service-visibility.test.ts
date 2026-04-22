import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockProfiles, mockDiscovered } = vi.hoisted(() => ({
  mockProfiles: [
    {
      id: 'profile-1',
      slug: 'acme',
      display_name: 'Acme',
      description: 'Acme ad tech',
      contact_email: 'hi@acme.example',
      contact_website: 'https://acme.example',
      is_public: true,
      created_at: new Date('2025-01-01'),
      agents: [
        { url: 'https://public.acme.example', visibility: 'public', name: 'Public One', type: 'buying' },
        { url: 'https://members.acme.example', visibility: 'members_only', name: 'Members Only', type: 'buying' },
        { url: 'https://private.acme.example', visibility: 'private', name: 'Private Draft', type: 'buying' },
      ],
    },
  ],
  mockDiscovered: [] as Array<Record<string, unknown>>,
}));

vi.mock('../../src/db/member-db.js', () => ({
  MemberDatabase: class {
    listProfiles = vi.fn().mockResolvedValue(mockProfiles);
  },
}));

vi.mock('../../src/db/federated-index-db.js', () => ({
  FederatedIndexDatabase: class {
    getAllDiscoveredAgents = vi.fn().mockResolvedValue(mockDiscovered);
  },
}));

const { AgentService } = await import('../../src/agent-service.js');

describe('AgentService.listAgents visibility filtering', () => {
  let service: InstanceType<typeof AgentService>;

  beforeEach(() => {
    service = new AgentService();
  });

  it('returns only public agents when viewer lacks API access', async () => {
    const agents = await service.listAgents();
    const urls = agents.map((a) => a.url).sort();
    expect(urls).toEqual(['https://public.acme.example']);
  });

  it('explicit viewerHasApiAccess=false matches default behavior', async () => {
    const agents = await service.listAgents({ viewerHasApiAccess: false });
    const urls = agents.map((a) => a.url).sort();
    expect(urls).toEqual(['https://public.acme.example']);
  });

  it('includes members_only agents when viewer has API access', async () => {
    const agents = await service.listAgents({ viewerHasApiAccess: true });
    const urls = agents.map((a) => a.url).sort();
    expect(urls).toEqual([
      'https://members.acme.example',
      'https://public.acme.example',
    ]);
  });

  it('never returns private agents even to API-access viewers', async () => {
    const agents = await service.listAgents({ viewerHasApiAccess: true });
    expect(agents.map((a) => a.url)).not.toContain('https://private.acme.example');
  });

  it('preserves type filter alongside visibility filter', async () => {
    const agents = await service.listAgents({ type: 'buying', viewerHasApiAccess: true });
    expect(agents.every((a) => a.type === 'buying')).toBe(true);
  });

  it('legacy signature (type string) still works and defaults to public only', async () => {
    const agents = await service.listAgents('buying');
    expect(agents.map((a) => a.url)).toEqual(['https://public.acme.example']);
  });
});
