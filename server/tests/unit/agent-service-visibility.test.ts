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
    {
      // Regression guard for #4194: profile NOT in member directory
      // (is_public=false) but has a visibility='public' agent. The old code
      // had an early-continue that hid this agent from public viewers. The
      // per-agent `visibility` is the only gate; is_public is the member-
      // directory flag and must not suppress the registry listing.
      id: 'profile-2',
      slug: 'nova',
      display_name: 'Nova Brands',
      description: 'Nova ad tech',
      contact_email: 'hi@nova.example',
      contact_website: 'https://nova.example',
      is_public: false,
      created_at: new Date('2025-01-01'),
      agents: [
        { url: 'https://public.nova.example', visibility: 'public', name: 'Nova Public', type: 'buying' },
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
    // Both the public-profile agent and the private-profile public agent appear.
    expect(urls).toEqual(['https://public.acme.example', 'https://public.nova.example']);
  });

  it('explicit viewerHasApiAccess=false matches default behavior', async () => {
    const agents = await service.listAgents({ viewerHasApiAccess: false });
    const urls = agents.map((a) => a.url).sort();
    expect(urls).toEqual(['https://public.acme.example', 'https://public.nova.example']);
  });

  it('includes members_only agents when viewer has API access', async () => {
    const agents = await service.listAgents({ viewerHasApiAccess: true });
    const urls = agents.map((a) => a.url).sort();
    expect(urls).toEqual([
      'https://members.acme.example',
      'https://public.acme.example',
      'https://public.nova.example',
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
    const urls = agents.map((a) => a.url).sort();
    expect(urls).toEqual(['https://public.acme.example', 'https://public.nova.example']);
  });

  it('public agent on private-profile member (is_public=false) is visible to all viewers (regression guard #4194)', async () => {
    // Before #4194 the old early-continue `if (visibility==='public' && !profile.is_public && !viewerHasApiAccess) continue`
    // silently hid this agent from public viewers. Per-agent visibility is the only gate.
    const agents = await service.listAgents();
    expect(agents.map((a) => a.url)).toContain('https://public.nova.example');
  });
});
