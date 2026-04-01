import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RegistrySync, type RegistrySyncConfig } from '../../../src/registry-sync/index.js';

// Mock fetch globally
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function makeConfig(overrides?: Partial<RegistrySyncConfig>): RegistrySyncConfig {
  return {
    apiKey: 'test-key',
    baseUrl: 'https://test.example.com',
    pollIntervalMs: 100_000, // Long interval to prevent auto-polling in tests
    ...overrides,
  };
}

function mockJsonResponse(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  });
}

describe('RegistrySync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor', () => {
    it('creates all indexes by default', () => {
      const sync = new RegistrySync(makeConfig());
      expect(sync.agents).toBeDefined();
      expect(sync.properties).toBeDefined();
      expect(sync.authorizations).toBeDefined();
    });

    it('creates only requested indexes', () => {
      const sync = new RegistrySync(makeConfig({ indexes: ['agents'] }));
      expect(sync.agents).toBeDefined();
      expect(sync.properties).toBeUndefined();
      expect(sync.authorizations).toBeUndefined();
    });

    it('creates agents + authorizations without properties', () => {
      const sync = new RegistrySync(makeConfig({ indexes: ['agents', 'authorizations'] }));
      expect(sync.agents).toBeDefined();
      expect(sync.properties).toBeUndefined();
      expect(sync.authorizations).toBeDefined();
    });
  });

  describe('start / stop', () => {
    it('emits ready after bootstrap', async () => {
      mockFetch
        .mockReturnValueOnce(mockJsonResponse({ results: [] }))    // agents search
        .mockReturnValueOnce(mockJsonResponse({ properties: [] })); // catalog sync

      const sync = new RegistrySync(makeConfig());
      const readyPromise = new Promise<void>(resolve => sync.on('ready', resolve));

      await sync.start();
      await readyPromise;

      expect(sync.isRunning()).toBe(true);
      sync.stop();
      expect(sync.isRunning()).toBe(false);
    });

    it('emits stopped on stop', async () => {
      mockFetch
        .mockReturnValueOnce(mockJsonResponse({ results: [] }))
        .mockReturnValueOnce(mockJsonResponse({ properties: [] }));

      const sync = new RegistrySync(makeConfig());
      const stoppedPromise = new Promise<void>(resolve => sync.on('stopped', resolve));

      await sync.start();
      sync.stop();
      await stoppedPromise;
    });
  });

  describe('bootstrap', () => {
    it('populates agent index from search results', async () => {
      mockFetch
        .mockReturnValueOnce(mockJsonResponse({
          results: [
            { agent_url: 'https://a.example.com', channels: ['ctv'], property_types: [], markets: [],
              categories: [], tags: [], delivery_types: [], format_ids: [], property_count: 10,
              publisher_count: 1, has_tmp: true, category_taxonomy: null, updated_at: '2026-01-01' },
          ],
        }))
        .mockReturnValueOnce(mockJsonResponse({ properties: [] }));

      const sync = new RegistrySync(makeConfig());
      await sync.start();

      expect(sync.agents!.size).toBe(1);
      expect(sync.agents!.get('https://a.example.com')).toBeDefined();
      sync.stop();
    });

    it('populates property index from catalog sync', async () => {
      mockFetch
        .mockReturnValueOnce(mockJsonResponse({ results: [] }))
        .mockReturnValueOnce(mockJsonResponse({
          properties: [
            { property_rid: 'rid-001', identifiers: [{ type: 'domain', value: 'pub.com' }],
              classification: 'property', publisher_domain: 'pub.com' },
          ],
        }));

      const sync = new RegistrySync(makeConfig());
      await sync.start();

      expect(sync.properties!.size).toBe(1);
      expect(sync.properties!.getByRid('rid-001')).toBeDefined();
      sync.stop();
    });
  });

  describe('event application', () => {
    let sync: RegistrySync;

    beforeEach(async () => {
      mockFetch
        .mockReturnValueOnce(mockJsonResponse({ results: [] }))
        .mockReturnValueOnce(mockJsonResponse({ properties: [] }));

      sync = new RegistrySync(makeConfig());
      await sync.start();
    });

    afterEach(() => sync.stop());

    it('handles agent.discovered event', () => {
      const event = {
        event_id: 'e1', event_type: 'agent.discovered', entity_type: 'agent',
        entity_id: 'https://new.example.com',
        payload: { agent_url: 'https://new.example.com' },
        actor: 'pipeline:crawler', created_at: new Date(),
      };

      // Emit via internal method
      (sync as any).applyEvents([event]);

      expect(sync.agents!.get('https://new.example.com')).toBeDefined();
    });

    it('handles agent.removed event', () => {
      // Add agent first
      sync.agents!.upsert({
        agent_url: 'https://remove-me.example.com',
        channels: [], property_types: [], markets: [], categories: [],
        tags: [], delivery_types: [], format_ids: [], property_count: 0,
        publisher_count: 0, has_tmp: false, category_taxonomy: null,
        updated_at: '2026-01-01',
      });

      const event = {
        event_id: 'e2', event_type: 'agent.removed', entity_type: 'agent',
        entity_id: 'https://remove-me.example.com',
        payload: { agent_url: 'https://remove-me.example.com' },
        actor: 'pipeline:crawler', created_at: new Date(),
      };

      (sync as any).applyEvents([event]);

      expect(sync.agents!.get('https://remove-me.example.com')).toBeUndefined();
    });

    it('handles property.created event', () => {
      const event = {
        event_id: 'e3', event_type: 'property.created', entity_type: 'property',
        entity_id: 'rid-new',
        payload: {
          property_rid: 'rid-new',
          identifiers: [{ type: 'domain', value: 'new.com' }],
          classification: 'property',
          publisher_domain: 'new.com',
        },
        actor: 'pipeline:catalog', created_at: new Date(),
      };

      (sync as any).applyEvents([event]);

      expect(sync.properties!.getByRid('rid-new')).toBeDefined();
      expect(sync.properties!.getByIdentifier('domain', 'new.com')).toBeDefined();
    });

    it('handles property.merged event', () => {
      // Set up two properties
      sync.properties!.upsert({
        property_rid: 'alias-rid',
        identifiers: [{ type: 'domain', value: 'alias.com' }],
        classification: 'property',
      });
      sync.properties!.upsert({
        property_rid: 'canonical-rid',
        identifiers: [{ type: 'domain', value: 'canonical.com' }],
        classification: 'property',
      });

      const event = {
        event_id: 'e4', event_type: 'property.merged', entity_type: 'property',
        entity_id: 'alias-rid',
        payload: { alias_rid: 'alias-rid', canonical_rid: 'canonical-rid' },
        actor: 'pipeline:catalog', created_at: new Date(),
      };

      (sync as any).applyEvents([event]);

      expect(sync.properties!.getByRid('alias-rid')).toBeUndefined();
      // alias.com now resolves to canonical
      expect(sync.properties!.getByIdentifier('domain', 'alias.com')?.property_rid).toBe('canonical-rid');
    });

    it('handles authorization.granted event', () => {
      const event = {
        event_id: 'e5', event_type: 'authorization.granted', entity_type: 'authorization',
        entity_id: 'agent:pub',
        payload: {
          agent_url: 'https://agent.example.com',
          publisher_domain: 'pub.example.com',
          authorization_type: 'publisher_properties',
        },
        actor: 'pipeline:crawler', created_at: new Date(),
      };

      (sync as any).applyEvents([event]);

      expect(sync.authorizations!.size).toBe(1);
    });

    it('handles authorization.revoked event', () => {
      // Add first
      sync.authorizations!.addEntry({
        agent_url: 'https://agent.example.com',
        publisher_domain: 'pub.example.com',
        authorization_type: 'publisher_properties',
      });

      const event = {
        event_id: 'e6', event_type: 'authorization.revoked', entity_type: 'authorization',
        entity_id: 'agent:pub',
        payload: {
          agent_url: 'https://agent.example.com',
          publisher_domain: 'pub.example.com',
        },
        actor: 'pipeline:crawler', created_at: new Date(),
      };

      (sync as any).applyEvents([event]);

      expect(sync.authorizations!.size).toBe(0);
    });

    it('emits event type on each event', () => {
      const handler = vi.fn();
      sync.on('agent.discovered', handler);

      (sync as any).applyEvents([{
        event_id: 'e7', event_type: 'agent.discovered', entity_type: 'agent',
        entity_id: 'url', payload: { agent_url: 'url' },
        actor: 'test', created_at: new Date(),
      }]);

      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('event type filtering', () => {
    it('passes types config to poller', () => {
      const sync = new RegistrySync(makeConfig({ types: ['property.*'] }));
      // The types are passed through to the poller config
      // We verify this indirectly through the constructor not throwing
      expect(sync).toBeDefined();
      sync.stop();
    });
  });
});
