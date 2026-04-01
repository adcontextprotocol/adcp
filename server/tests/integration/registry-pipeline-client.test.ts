import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RegistrySync } from '../../src/registry-sync/index.js';
import type { CatalogEvent } from '../../src/db/catalog-events-db.js';

/**
 * Client-side pipeline test.
 * Pre-populates events, applies them to RegistrySync, verifies indexes update.
 * No real database or HTTP needed — tests the event application logic.
 */

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockJsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

function makeEvent(overrides: Partial<CatalogEvent> & { event_type: string }): CatalogEvent {
  return {
    event_id: `evt-${Math.random().toString(36).slice(2)}`,
    entity_type: overrides.event_type.split('.')[0],
    entity_id: 'test-entity',
    payload: {},
    actor: 'test',
    created_at: new Date(),
    ...overrides,
  };
}

describe('Registry Pipeline Client Tests', () => {
  let sync: RegistrySync;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Bootstrap with empty data
    mockFetch
      .mockReturnValueOnce(mockJsonResponse({ results: [] }))
      .mockReturnValueOnce(mockJsonResponse({ properties: [] }));

    sync = new RegistrySync({
      apiKey: 'test',
      baseUrl: 'https://test.example.com',
      pollIntervalMs: 999_999, // prevent auto-polling
    });

    await sync.start();
  });

  afterEach(() => sync.stop());

  // ── Agent lifecycle through events ──────────────────────────────

  describe('agent lifecycle', () => {
    it('agent appears after agent.discovered event', () => {
      (sync as any).applyEvents([
        makeEvent({
          event_type: 'agent.discovered',
          entity_id: 'https://new-agent.example.com',
          payload: { agent_url: 'https://new-agent.example.com' },
        }),
      ]);

      expect(sync.agents!.size).toBe(1);
      const agent = sync.agents!.get('https://new-agent.example.com');
      expect(agent).toBeDefined();
      expect(agent!.agent_url).toBe('https://new-agent.example.com');
    });

    it('agent disappears after agent.removed event', () => {
      // Discover then remove
      (sync as any).applyEvents([
        makeEvent({
          event_type: 'agent.discovered',
          entity_id: 'https://temp.example.com',
          payload: { agent_url: 'https://temp.example.com' },
        }),
      ]);
      expect(sync.agents!.size).toBe(1);

      (sync as any).applyEvents([
        makeEvent({
          event_type: 'agent.removed',
          entity_id: 'https://temp.example.com',
          payload: { agent_url: 'https://temp.example.com' },
        }),
      ]);
      expect(sync.agents!.size).toBe(0);
    });

    it('agent.removed also clears authorization entries', () => {
      sync.authorizations!.addEntry({
        agent_url: 'https://doomed.example.com',
        publisher_domain: 'pub.com',
        authorization_type: 'publisher_properties',
      });
      expect(sync.authorizations!.size).toBe(1);

      (sync as any).applyEvents([
        makeEvent({
          event_type: 'agent.removed',
          entity_id: 'https://doomed.example.com',
          payload: { agent_url: 'https://doomed.example.com' },
        }),
      ]);
      expect(sync.authorizations!.size).toBe(0);
    });
  });

  // ── Property lifecycle through events ───────────────────────────

  describe('property lifecycle', () => {
    it('property appears after property.created event', () => {
      (sync as any).applyEvents([
        makeEvent({
          event_type: 'property.created',
          entity_id: 'rid-new',
          payload: {
            property_rid: 'rid-new',
            identifiers: [{ type: 'domain', value: 'newsite.com' }],
            classification: 'property',
            publisher_domain: 'newsite.com',
          },
        }),
      ]);

      expect(sync.properties!.size).toBe(1);
      expect(sync.properties!.getByRid('rid-new')).toBeDefined();
      expect(sync.properties!.getByIdentifier('domain', 'newsite.com')).toBeDefined();
    });

    it('property merge redirects identifiers', () => {
      // Create two properties
      (sync as any).applyEvents([
        makeEvent({
          event_type: 'property.created',
          entity_id: 'alias-rid',
          payload: {
            property_rid: 'alias-rid',
            identifiers: [{ type: 'domain', value: 'old.com' }],
            classification: 'property',
          },
        }),
        makeEvent({
          event_type: 'property.created',
          entity_id: 'canonical-rid',
          payload: {
            property_rid: 'canonical-rid',
            identifiers: [{ type: 'domain', value: 'new.com' }],
            classification: 'property',
          },
        }),
      ]);

      expect(sync.properties!.size).toBe(2);

      // Merge alias into canonical
      (sync as any).applyEvents([
        makeEvent({
          event_type: 'property.merged',
          entity_id: 'alias-rid',
          payload: { alias_rid: 'alias-rid', canonical_rid: 'canonical-rid' },
        }),
      ]);

      expect(sync.properties!.size).toBe(1);
      expect(sync.properties!.getByRid('alias-rid')).toBeUndefined();
      expect(sync.properties!.getByIdentifier('domain', 'old.com')?.property_rid).toBe('canonical-rid');
    });
  });

  // ── Authorization lifecycle through events ──────────────────────

  describe('authorization lifecycle', () => {
    it('authorization appears after authorization.granted event', () => {
      // Set up property first so authorization can resolve
      sync.properties!.upsert({
        property_rid: 'rid-pub',
        identifiers: [{ type: 'domain', value: 'pub.com' }],
        classification: 'property',
        publisher_domain: 'pub.com',
      });

      (sync as any).applyEvents([
        makeEvent({
          event_type: 'authorization.granted',
          entity_id: 'agent:pub',
          payload: {
            agent_url: 'https://seller.example.com',
            publisher_domain: 'pub.com',
            authorization_type: 'publisher_properties',
            delegation_type: 'direct',
          },
        }),
      ]);

      expect(sync.authorizations!.size).toBe(1);

      // Verify the authorization works for the property
      const result = sync.authorizations!.check({
        agent_url: 'https://seller.example.com',
        property_rid: 'rid-pub',
      });
      expect(result.authorized).toBe(true);
      expect(result.delegation_type).toBe('direct');
    });

    it('authorization disappears after authorization.revoked event', () => {
      sync.authorizations!.addEntry({
        agent_url: 'https://seller.example.com',
        publisher_domain: 'pub.com',
        authorization_type: 'publisher_properties',
      });

      (sync as any).applyEvents([
        makeEvent({
          event_type: 'authorization.revoked',
          entity_id: 'agent:pub',
          payload: {
            agent_url: 'https://seller.example.com',
            publisher_domain: 'pub.com',
          },
        }),
      ]);

      expect(sync.authorizations!.size).toBe(0);
    });

    it('reverse index updates from events', () => {
      sync.properties!.upsert({
        property_rid: 'rid-pub2',
        identifiers: [],
        classification: 'property',
        publisher_domain: 'pub2.com',
      });

      (sync as any).applyEvents([
        makeEvent({
          event_type: 'authorization.granted',
          entity_id: 'a1:pub2',
          payload: {
            agent_url: 'https://agent1.example.com',
            publisher_domain: 'pub2.com',
            authorization_type: 'publisher_properties',
          },
        }),
        makeEvent({
          event_type: 'authorization.granted',
          entity_id: 'a2:pub2',
          payload: {
            agent_url: 'https://agent2.example.com',
            publisher_domain: 'pub2.com',
            authorization_type: 'publisher_properties',
          },
        }),
      ]);

      const agents = sync.authorizations!.getAuthorizedAgents('rid-pub2');
      expect(agents).toContain('https://agent1.example.com');
      expect(agents).toContain('https://agent2.example.com');
    });
  });

  // ── Event ordering ──────────────────────────────────────────────

  describe('event ordering', () => {
    it('processes events in order (create then update)', () => {
      (sync as any).applyEvents([
        makeEvent({
          event_type: 'property.created',
          entity_id: 'rid-evolving',
          payload: {
            property_rid: 'rid-evolving',
            identifiers: [{ type: 'domain', value: 'v1.com' }],
            classification: 'property',
            publisher_domain: 'v1.com',
          },
        }),
        makeEvent({
          event_type: 'property.updated',
          entity_id: 'rid-evolving',
          payload: {
            property_rid: 'rid-evolving',
            classification: 'ad_infra',
          },
        }),
      ]);

      const prop = sync.properties!.getByRid('rid-evolving');
      expect(prop!.classification).toBe('ad_infra');
    });
  });

  // ── EventEmitter ────────────────────────────────────────────────

  describe('event emitter', () => {
    it('emits typed events for each event', () => {
      const handler = vi.fn();
      sync.on('agent.discovered', handler);

      (sync as any).applyEvents([
        makeEvent({
          event_type: 'agent.discovered',
          entity_id: 'https://emit-test.example.com',
          payload: { agent_url: 'https://emit-test.example.com' },
        }),
      ]);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].event_type).toBe('agent.discovered');
    });

    it('emits multiple event types', () => {
      const agentHandler = vi.fn();
      const authHandler = vi.fn();
      sync.on('agent.discovered', agentHandler);
      sync.on('authorization.granted', authHandler);

      (sync as any).applyEvents([
        makeEvent({
          event_type: 'agent.discovered',
          entity_id: 'url',
          payload: { agent_url: 'url' },
        }),
        makeEvent({
          event_type: 'authorization.granted',
          entity_id: 'a:p',
          payload: { agent_url: 'url', publisher_domain: 'p.com', authorization_type: 'publisher_properties' },
        }),
      ]);

      expect(agentHandler).toHaveBeenCalledOnce();
      expect(authHandler).toHaveBeenCalledOnce();
    });
  });

  // ── Composable indexes ──────────────────────────────────────────

  describe('composable indexes', () => {
    it('agents-only mode ignores property and auth events', async () => {
      vi.clearAllMocks();
      mockFetch
        .mockReturnValueOnce(mockJsonResponse({ results: [] }))
        .mockReturnValueOnce(mockJsonResponse({ properties: [] }));

      const agentsOnly = new RegistrySync({
        apiKey: 'test',
        baseUrl: 'https://test.example.com',
        pollIntervalMs: 999_999,
        indexes: ['agents'],
      });
      await agentsOnly.start();

      expect(agentsOnly.agents).toBeDefined();
      expect(agentsOnly.properties).toBeUndefined();
      expect(agentsOnly.authorizations).toBeUndefined();

      // Events for disabled indexes should not throw
      (agentsOnly as any).applyEvents([
        makeEvent({
          event_type: 'property.created',
          entity_id: 'rid',
          payload: { property_rid: 'rid', identifiers: [] },
        }),
        makeEvent({
          event_type: 'authorization.granted',
          entity_id: 'a:p',
          payload: { agent_url: 'u', publisher_domain: 'p', authorization_type: 'x' },
        }),
      ]);

      // Agent events still work
      (agentsOnly as any).applyEvents([
        makeEvent({
          event_type: 'agent.discovered',
          entity_id: 'url',
          payload: { agent_url: 'url' },
        }),
      ]);
      expect(agentsOnly.agents!.size).toBe(1);

      agentsOnly.stop();
    });
  });
});
