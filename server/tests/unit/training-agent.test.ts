import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildCatalog } from '../../src/training-agent/product-factory.js';
import { buildFormats, FORMAT_CHANNEL_MAP } from '../../src/training-agent/formats.js';
import { PUBLISHERS } from '../../src/training-agent/publishers.js';
import {
  getSession,
  sessionKeyFromArgs,
  clearSessions,
  startSessionCleanup,
  stopSessionCleanup,
} from '../../src/training-agent/state.js';
import {
  createTrainingAgentServer,
  invalidateCache,
} from '../../src/training-agent/task-handlers.js';
import type { TrainingContext } from '../../src/training-agent/types.js';

// Valid channels per the enum schema at static/schemas/source/enums/channels.json
const VALID_CHANNELS = [
  'display', 'olv', 'social', 'search', 'ctv', 'linear_tv', 'radio',
  'streaming_audio', 'podcast', 'dooh', 'ooh', 'print', 'cinema',
  'email', 'gaming', 'retail_media', 'influencer', 'affiliate',
  'product_placement',
] as const;

const VALID_PRICING_MODELS = [
  'cpm', 'vcpm', 'cpc', 'cpcv', 'cpv', 'cpp', 'cpa', 'flat_rate', 'time',
] as const;

const TEST_AGENT_URL = 'http://localhost:3000/api/training-agent';

const DEFAULT_CTX: TrainingContext = { mode: 'open' };

/**
 * Simulate ListTools request on an MCP server.
 * The MCP SDK Server stores handlers in a Map keyed by method string.
 */
async function simulateListTools(server: ReturnType<typeof createTrainingAgentServer>): Promise<{ tools: Array<{ name: string }> }> {
  const requestHandlers = (server as any)._requestHandlers as Map<string, Function>;
  const handler = requestHandlers.get('tools/list');
  if (!handler) {
    throw new Error('ListTools handler not found');
  }
  return handler({ method: 'tools/list' }, {});
}

/**
 * Simulate CallTool request on an MCP server.
 */
async function simulateCallTool(
  server: ReturnType<typeof createTrainingAgentServer>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ result: Record<string, unknown>; isError?: boolean }> {
  const requestHandlers = (server as any)._requestHandlers as Map<string, Function>;
  const handler = requestHandlers.get('tools/call');
  if (!handler) {
    throw new Error('CallTool handler not found');
  }
  const response = await handler(
    { method: 'tools/call', params: { name: toolName, arguments: args } },
    {},
  );
  const text = response.content?.[0]?.text;
  return {
    result: text ? JSON.parse(text) : {},
    isError: response.isError,
  };
}

// ── Catalog (buildCatalog) ─────────────────────────────────────────

describe('buildCatalog', () => {
  let catalog: ReturnType<typeof buildCatalog>;

  beforeEach(() => {
    invalidateCache();
    catalog = buildCatalog();
  });

  it('produces at least one product per publisher', () => {
    const publisherIds = new Set(catalog.map(cp => cp.publisherId));
    for (const pub of PUBLISHERS) {
      expect(publisherIds.has(pub.id)).toBe(true);
    }
  });

  describe('schema-required fields on every product', () => {
    // product.json required: product_id, name, description,
    // publisher_properties, format_ids, delivery_type, delivery_measurement, pricing_options

    it('has product_id as a non-empty string', () => {
      for (const cp of catalog) {
        expect(typeof cp.product.product_id).toBe('string');
        expect((cp.product.product_id as string).length).toBeGreaterThan(0);
      }
    });

    it('has name as a non-empty string', () => {
      for (const cp of catalog) {
        expect(typeof cp.product.name).toBe('string');
        expect((cp.product.name as string).length).toBeGreaterThan(0);
      }
    });

    it('has description as a non-empty string', () => {
      for (const cp of catalog) {
        expect(typeof cp.product.description).toBe('string');
        expect((cp.product.description as string).length).toBeGreaterThan(0);
      }
    });

    it('has publisher_properties as a non-empty array', () => {
      for (const cp of catalog) {
        const props = cp.product.publisher_properties as unknown[];
        expect(Array.isArray(props)).toBe(true);
        expect(props.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('has format_ids as a non-empty array', () => {
      for (const cp of catalog) {
        const fids = cp.product.format_ids as unknown[];
        expect(Array.isArray(fids)).toBe(true);
        expect(fids.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('has delivery_type as guaranteed or non_guaranteed', () => {
      for (const cp of catalog) {
        expect(['guaranteed', 'non_guaranteed']).toContain(cp.product.delivery_type);
      }
    });

    it('has delivery_measurement with required provider field', () => {
      for (const cp of catalog) {
        const dm = cp.product.delivery_measurement as Record<string, unknown>;
        expect(dm).toBeDefined();
        expect(typeof dm.provider).toBe('string');
        expect((dm.provider as string).length).toBeGreaterThan(0);
      }
    });

    it('has pricing_options as a non-empty array', () => {
      for (const cp of catalog) {
        const opts = cp.product.pricing_options as unknown[];
        expect(Array.isArray(opts)).toBe(true);
        expect(opts.length).toBeGreaterThanOrEqual(1);
      }
    });
  });

  describe('channels enum compliance', () => {
    it('every channel value is in the channels enum', () => {
      for (const cp of catalog) {
        const channels = cp.product.channels as string[];
        for (const channel of channels) {
          expect(VALID_CHANNELS).toContain(channel);
        }
      }
    });

    it('covers publisher channels across the catalog', () => {
      const allChannels = new Set<string>();
      for (const cp of catalog) {
        for (const ch of cp.product.channels as string[]) {
          allChannels.add(ch);
        }
      }
      // Every publisher channel should appear in at least one product
      const publisherChannels = new Set<string>();
      for (const pub of PUBLISHERS) {
        for (const ch of pub.channels) {
          publisherChannels.add(ch);
        }
      }
      for (const ch of publisherChannels) {
        expect(allChannels.has(ch)).toBe(true);
      }
    });
  });

  describe('format_id structure', () => {
    it('every format_id has agent_url and id as strings', () => {
      for (const cp of catalog) {
        const fids = cp.product.format_ids as Array<Record<string, unknown>>;
        for (const fid of fids) {
          expect(typeof fid.agent_url).toBe('string');
          expect((fid.agent_url as string).length).toBeGreaterThan(0);
          expect(typeof fid.id).toBe('string');
          expect((fid.id as string).length).toBeGreaterThan(0);
        }
      }
    });

    it('format id values match the pattern ^[a-zA-Z0-9_-]+$', () => {
      const pattern = /^[a-zA-Z0-9_-]+$/;
      for (const cp of catalog) {
        const fids = cp.product.format_ids as Array<Record<string, unknown>>;
        for (const fid of fids) {
          expect((fid.id as string)).toMatch(pattern);
        }
      }
    });
  });

  describe('publisher_properties selectors', () => {
    it('every selector has publisher_domain and selection_type', () => {
      for (const cp of catalog) {
        const props = cp.product.publisher_properties as Array<Record<string, unknown>>;
        for (const prop of props) {
          expect(typeof prop.publisher_domain).toBe('string');
          expect(['all', 'by_id', 'by_tag']).toContain(prop.selection_type);
        }
      }
    });

    it('by_id selectors include property_ids array', () => {
      for (const cp of catalog) {
        const props = cp.product.publisher_properties as Array<Record<string, unknown>>;
        for (const prop of props) {
          if (prop.selection_type === 'by_id') {
            const propertyIds = prop.property_ids as string[];
            expect(Array.isArray(propertyIds)).toBe(true);
            expect(propertyIds.length).toBeGreaterThanOrEqual(1);
            for (const pid of propertyIds) {
              expect(typeof pid).toBe('string');
              expect(pid).toMatch(/^[a-z0-9_]+$/);
            }
          }
        }
      }
    });

    it('publisher_domain uses the publisher profile domain', () => {
      const pubDomains = new Set(PUBLISHERS.map(p => p.domain));
      for (const cp of catalog) {
        const props = cp.product.publisher_properties as Array<Record<string, unknown>>;
        for (const prop of props) {
          expect(pubDomains.has(prop.publisher_domain as string)).toBe(true);
        }
      }
    });
  });

  describe('pricing_options compliance', () => {
    it('every pricing option has pricing_option_id, pricing_model, and currency', () => {
      for (const cp of catalog) {
        const opts = cp.product.pricing_options as Array<Record<string, unknown>>;
        for (const opt of opts) {
          expect(typeof opt.pricing_option_id).toBe('string');
          expect((opt.pricing_option_id as string).length).toBeGreaterThan(0);
          expect(VALID_PRICING_MODELS).toContain(opt.pricing_model);
          expect(typeof opt.currency).toBe('string');
          expect(opt.currency).toMatch(/^[A-Z]{3}$/);
        }
      }
    });

    it('fixed_price is a non-negative number when present', () => {
      for (const cp of catalog) {
        const opts = cp.product.pricing_options as Array<Record<string, unknown>>;
        for (const opt of opts) {
          if (opt.fixed_price !== undefined) {
            expect(typeof opt.fixed_price).toBe('number');
            expect(opt.fixed_price as number).toBeGreaterThanOrEqual(0);
          }
        }
      }
    });

    it('floor_price is a non-negative number when present', () => {
      for (const cp of catalog) {
        const opts = cp.product.pricing_options as Array<Record<string, unknown>>;
        for (const opt of opts) {
          if (opt.floor_price !== undefined) {
            expect(typeof opt.floor_price).toBe('number');
            expect(opt.floor_price as number).toBeGreaterThanOrEqual(0);
          }
        }
      }
    });

    it('price_guidance has percentile fields when present', () => {
      for (const cp of catalog) {
        const opts = cp.product.pricing_options as Array<Record<string, unknown>>;
        for (const opt of opts) {
          if (opt.price_guidance) {
            const pg = opt.price_guidance as Record<string, unknown>;
            expect(typeof pg.p25).toBe('number');
            expect(typeof pg.p50).toBe('number');
            expect(typeof pg.p75).toBe('number');
            expect(typeof pg.p90).toBe('number');
          }
        }
      }
    });

    it('pricing_option_id values are unique within each product', () => {
      for (const cp of catalog) {
        const opts = cp.product.pricing_options as Array<Record<string, unknown>>;
        const ids = opts.map(o => o.pricing_option_id);
        expect(new Set(ids).size).toBe(ids.length);
      }
    });
  });

  describe('reporting_capabilities compliance', () => {
    it('uses available_reporting_frequencies (not reporting_frequency) and includes required fields', () => {
      const withReporting = catalog.filter(cp => cp.product.reporting_capabilities);
      expect(withReporting.length).toBeGreaterThan(0);

      for (const cp of withReporting) {
        const rc = cp.product.reporting_capabilities as Record<string, unknown>;
        // Must use correct field name
        expect(rc.available_reporting_frequencies).toBeDefined();
        expect(Array.isArray(rc.available_reporting_frequencies)).toBe(true);
        expect((rc.available_reporting_frequencies as unknown[]).length).toBeGreaterThan(0);
        // Must NOT have old field name
        expect(rc).not.toHaveProperty('reporting_frequency');
        // Required fields per schema
        expect(typeof rc.expected_delay_minutes).toBe('number');
        expect(typeof rc.timezone).toBe('string');
        expect(typeof rc.supports_webhooks).toBe('boolean');
        expect(typeof rc.date_range_support).toBe('string');
      }
    });
  });

  describe('training metadata', () => {
    it('every catalog product has a valid trainingTier', () => {
      for (const cp of catalog) {
        expect(['basics', 'practitioner', 'specialist']).toContain(cp.trainingTier);
      }
    });

    it('every catalog product has scenarioTags as an array', () => {
      for (const cp of catalog) {
        expect(Array.isArray(cp.scenarioTags)).toBe(true);
      }
    });
  });
});

// ── Formats (buildFormats) ─────────────────────────────────────────

describe('buildFormats', () => {
  let formats: Record<string, unknown>[];

  beforeEach(() => {
    formats = buildFormats(TEST_AGENT_URL);
  });

  it('produces a non-empty array', () => {
    expect(formats.length).toBeGreaterThan(0);
  });

  describe('schema-required fields on every format', () => {
    // format.json required: format_id, name

    it('has format_id with agent_url and id', () => {
      for (const fmt of formats) {
        const fid = fmt.format_id as Record<string, unknown>;
        expect(typeof fid.agent_url).toBe('string');
        expect(fid.agent_url).toBe(TEST_AGENT_URL);
        expect(typeof fid.id).toBe('string');
        expect((fid.id as string)).toMatch(/^[a-zA-Z0-9_-]+$/);
      }
    });

    it('has name as a non-empty string', () => {
      for (const fmt of formats) {
        expect(typeof fmt.name).toBe('string');
        expect((fmt.name as string).length).toBeGreaterThan(0);
      }
    });
  });

  it('every format has renders array with at least one entry', () => {
    for (const fmt of formats) {
      const renders = fmt.renders as unknown[];
      expect(Array.isArray(renders)).toBe(true);
      expect(renders.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('every render has a role string', () => {
    for (const fmt of formats) {
      const renders = fmt.renders as Array<Record<string, unknown>>;
      for (const render of renders) {
        expect(typeof render.role).toBe('string');
      }
    }
  });

  it('renders have either dimensions or parameters_from_format_id', () => {
    for (const fmt of formats) {
      const renders = fmt.renders as Array<Record<string, unknown>>;
      for (const render of renders) {
        const hasDimensions = render.dimensions !== undefined;
        const hasParamsFromFid = render.parameters_from_format_id === true;
        expect(hasDimensions || hasParamsFromFid).toBe(true);
      }
    }
  });

  it('format_id values are unique across all formats', () => {
    const ids = formats.map(f => (f.format_id as Record<string, unknown>).id as string);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every format with assets has items with required fields', () => {
    for (const fmt of formats) {
      const assets = fmt.assets as Array<Record<string, unknown>> | undefined;
      if (!assets) continue;
      for (const asset of assets) {
        if (asset.item_type === 'individual') {
          expect(typeof asset.asset_id).toBe('string');
          expect(typeof asset.asset_type).toBe('string');
          expect(typeof asset.required).toBe('boolean');
        } else if (asset.item_type === 'repeatable_group') {
          expect(typeof asset.asset_group_id).toBe('string');
          expect(typeof asset.required).toBe('boolean');
          expect(typeof asset.min_count).toBe('number');
          expect(typeof asset.max_count).toBe('number');
          expect(Array.isArray(asset.assets)).toBe(true);
        }
      }
    }
  });
});

// ── FORMAT_CHANNEL_MAP ─────────────────────────────────────────────

describe('FORMAT_CHANNEL_MAP', () => {
  it('maps every format id from buildFormats', () => {
    const formats = buildFormats(TEST_AGENT_URL);
    const formatIds = formats.map(f => (f.format_id as Record<string, unknown>).id as string);
    for (const fmtId of formatIds) {
      expect(FORMAT_CHANNEL_MAP).toHaveProperty(fmtId);
    }
  });

  it('every channel in the map is a valid channel enum value', () => {
    for (const channels of Object.values(FORMAT_CHANNEL_MAP)) {
      for (const ch of channels) {
        expect(VALID_CHANNELS).toContain(ch);
      }
    }
  });
});

// ── Session state ──────────────────────────────────────────────────

describe('session state', () => {
  beforeEach(() => {
    clearSessions();
    stopSessionCleanup();
  });

  afterEach(() => {
    clearSessions();
    stopSessionCleanup();
  });

  describe('getSession', () => {
    it('creates a new session with empty maps', () => {
      const session = getSession('test-key');
      expect(session.mediaBuys).toBeInstanceOf(Map);
      expect(session.mediaBuys.size).toBe(0);
      expect(session.creatives).toBeInstanceOf(Map);
      expect(session.creatives.size).toBe(0);
    });

    it('returns the same session for the same key', () => {
      const s1 = getSession('test-key');
      s1.mediaBuys.set('mb1', {} as any);
      const s2 = getSession('test-key');
      expect(s2.mediaBuys.has('mb1')).toBe(true);
    });

    it('returns different sessions for different keys', () => {
      const s1 = getSession('key-a');
      const s2 = getSession('key-b');
      s1.mediaBuys.set('mb1', {} as any);
      expect(s2.mediaBuys.has('mb1')).toBe(false);
    });

    it('updates lastAccessedAt on every access', () => {
      const s1 = getSession('test-key');
      const firstAccess = s1.lastAccessedAt;
      // Tiny delay to get a different timestamp
      const s2 = getSession('test-key');
      expect(s2.lastAccessedAt.getTime()).toBeGreaterThanOrEqual(firstAccess.getTime());
    });
  });

  describe('sessionKeyFromArgs', () => {
    it('uses training prefix for training mode with userId', () => {
      const key = sessionKeyFromArgs({}, 'training', 'user123', 'mod456');
      expect(key).toBe('training:user123:mod456');
    });

    it('uses default moduleId when not provided in training mode', () => {
      const key = sessionKeyFromArgs({}, 'training', 'user123');
      expect(key).toBe('training:user123:default');
    });

    it('uses open prefix with brand domain when available', () => {
      const key = sessionKeyFromArgs(
        { account: { brand: { domain: 'acme.example' } } },
        'open',
      );
      expect(key).toBe('open:acme.example');
    });

    it('uses open:default when no brand domain', () => {
      const key = sessionKeyFromArgs({}, 'open');
      expect(key).toBe('open:default');
    });

    it('falls back to open mode when training mode has no userId', () => {
      const key = sessionKeyFromArgs(
        { account: { brand: { domain: 'test.example' } } },
        'training',
      );
      expect(key).toBe('open:test.example');
    });
  });

  describe('cleanup', () => {
    it('startSessionCleanup does not throw', () => {
      expect(() => startSessionCleanup()).not.toThrow();
    });

    it('stopSessionCleanup is idempotent', () => {
      startSessionCleanup();
      stopSessionCleanup();
      stopSessionCleanup(); // second call should not throw
    });

    it('clearSessions removes all sessions', () => {
      getSession('a');
      getSession('b');
      clearSessions();
      // After clearing, getting a key should produce a fresh session
      const s = getSession('a');
      expect(s.mediaBuys.size).toBe(0);
    });
  });
});

// ── MCP Server creation ────────────────────────────────────────────

describe('createTrainingAgentServer', () => {
  beforeEach(() => {
    invalidateCache();
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
  });

  it('creates a server instance', () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    expect(server).toBeDefined();
  });

  it('registers the expected tools', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { tools } = await simulateListTools(server);
    const toolNames = tools.map(t => t.name);

    expect(toolNames).toContain('get_products');
    expect(toolNames).toContain('list_creative_formats');
    expect(toolNames).toContain('create_media_buy');
    expect(toolNames).toContain('get_media_buys');
    expect(toolNames).toContain('get_media_buy_delivery');
    expect(toolNames).toContain('sync_creatives');
    expect(toolNames).toContain('list_creatives');
    expect(toolNames).toContain('update_media_buy');
    expect(toolNames).toHaveLength(8);
  });

  it('returns error for unknown tool', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result, isError } = await simulateCallTool(server, 'nonexistent_tool', {});
    expect(isError).toBe(true);
    expect(result.error).toContain('Unknown tool');
  });
});

// ── get_products handler ───────────────────────────────────────────

describe('get_products handler', () => {
  beforeEach(() => {
    invalidateCache();
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
  });

  it('returns products array (wholesale mode)', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_products', {
      buying_mode: 'wholesale',
    });

    expect(Array.isArray(result.products)).toBe(true);
    expect((result.products as unknown[]).length).toBeGreaterThan(0);
    expect(result.sandbox).toBe(true);
  });

  it('filters by channel', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_products', {
      buying_mode: 'wholesale',
      filters: { channels: ['ctv'] },
    });

    const products = result.products as Array<Record<string, unknown>>;
    expect(products.length).toBeGreaterThan(0);
    for (const p of products) {
      expect((p.channels as string[]).includes('ctv')).toBe(true);
    }
  });

  it('filters by delivery_type', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_products', {
      buying_mode: 'wholesale',
      filters: { delivery_type: 'guaranteed' },
    });

    const products = result.products as Array<Record<string, unknown>>;
    expect(products.length).toBeGreaterThan(0);
    for (const p of products) {
      expect(p.delivery_type).toBe('guaranteed');
    }
  });

  it('returns products in brief mode with keyword matching', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_products', {
      buying_mode: 'brief',
      brief: 'video sports streaming',
    });

    const products = result.products as Array<Record<string, unknown>>;
    expect(products.length).toBeGreaterThan(0);
    // Brief mode adds brief_relevance to matched products
    const hasRelevance = products.some(p => p.brief_relevance !== undefined);
    expect(hasRelevance).toBe(true);
  });

  it('returns suggestions when brief has no keyword matches', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_products', {
      buying_mode: 'brief',
      brief: 'xyznonexistentkeyword',
    });

    const products = result.products as Array<Record<string, unknown>>;
    expect(products.length).toBeGreaterThan(0);
  });

  it('every product in response has all schema-required fields', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_products', {
      buying_mode: 'wholesale',
    });

    const products = result.products as Array<Record<string, unknown>>;
    for (const p of products) {
      expect(typeof p.product_id).toBe('string');
      expect(typeof p.name).toBe('string');
      expect(typeof p.description).toBe('string');
      expect(Array.isArray(p.publisher_properties)).toBe(true);
      expect(Array.isArray(p.format_ids)).toBe(true);
      expect(typeof p.delivery_type).toBe('string');
      expect(p.delivery_measurement).toBeDefined();
      expect(Array.isArray(p.pricing_options)).toBe(true);
    }
  });
});

// ── list_creative_formats handler ──────────────────────────────────

describe('list_creative_formats handler', () => {
  beforeEach(() => {
    invalidateCache();
  });

  it('returns all formats when no filters', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'list_creative_formats', {});

    const formats = result.formats as Array<Record<string, unknown>>;
    expect(formats.length).toBeGreaterThan(0);
    expect(result.sandbox).toBe(true);
  });

  it('filters by channels', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'list_creative_formats', {
      channels: ['dooh'],
    });

    const formats = result.formats as Array<Record<string, unknown>>;
    expect(formats.length).toBeGreaterThan(0);
    const ids = formats.map(f => (f.format_id as Record<string, unknown>).id as string);
    // DOOH formats should be present
    expect(ids.some(id => id.startsWith('dooh'))).toBe(true);
  });

  it('filters by format_ids', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'list_creative_formats', {
      format_ids: [{ agent_url: TEST_AGENT_URL, id: 'display_300x250' }],
    });

    const formats = result.formats as Array<Record<string, unknown>>;
    expect(formats).toHaveLength(1);
    expect((formats[0].format_id as Record<string, unknown>).id).toBe('display_300x250');
  });
});

// ── create_media_buy handler ───────────────────────────────────────

describe('create_media_buy handler', () => {
  beforeEach(() => {
    invalidateCache();
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
  });

  function getFirstProductAndPricing(): { productId: string; pricingOptionId: string } {
    const catalog = buildCatalog();
    const product = catalog[0].product;
    const pricingOptions = product.pricing_options as Array<Record<string, unknown>>;
    return {
      productId: product.product_id as string,
      pricingOptionId: pricingOptions[0].pricing_option_id as string,
    };
  }

  it('creates a media buy with valid input', async () => {
    const { productId, pricingOptionId } = getFirstProductAndPricing();
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'test-buyer-001',
      account: { brand: { domain: 'test.example' } },
      brand: { domain: 'test.example' },
      start_time: '2025-06-01T00:00:00Z',
      end_time: '2025-07-01T00:00:00Z',
      packages: [{
        product_id: productId,
        pricing_option_id: pricingOptionId,
        budget: 50000,
        buyer_ref: 'pkg-buyer-001',
        start_time: '2025-06-01T00:00:00Z',
        end_time: '2025-07-01T00:00:00Z',
      }],
    });

    // Success response: media_buy_id, buyer_ref, packages (required per schema)
    expect(typeof result.media_buy_id).toBe('string');
    expect(result.buyer_ref).toBe('test-buyer-001');
    expect(Array.isArray(result.packages)).toBe(true);
    expect((result.packages as unknown[]).length).toBe(1);
    expect(result.sandbox).toBe(true);
    // Error field should not be present on success
    expect(result.errors).toBeUndefined();
  });

  it('returns package with required fields', async () => {
    const { productId, pricingOptionId } = getFirstProductAndPricing();
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'test-buyer-002',
      account: { brand: { domain: 'test.example' } },
      brand: { domain: 'test.example' },
      start_time: '2025-06-01T00:00:00Z',
      end_time: '2025-07-01T00:00:00Z',
      packages: [{
        product_id: productId,
        pricing_option_id: pricingOptionId,
        budget: 10000,
        buyer_ref: 'pkg-buyer-002',
        start_time: '2025-06-01T00:00:00Z',
        end_time: '2025-07-01T00:00:00Z',
      }],
    });

    const pkg = (result.packages as Array<Record<string, unknown>>)[0];
    expect(typeof pkg.package_id).toBe('string');
    expect(pkg.product_id).toBe(productId);
    expect(pkg.budget).toBe(10000);
    expect(pkg.pricing_option_id).toBe(pricingOptionId);
    expect(typeof pkg.start_time).toBe('string');
    expect(typeof pkg.end_time).toBe('string');
  });

  it('returns error for empty packages', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'test-buyer-003',
      account: { brand: { domain: 'test.example' } },
      brand: { domain: 'test.example' },
      start_time: '2025-06-01T00:00:00Z',
      end_time: '2025-07-01T00:00:00Z',
      packages: [],
    });

    expect(result.errors).toBeDefined();
    expect(Array.isArray(result.errors)).toBe(true);
    // No success fields on error
    expect(result.media_buy_id).toBeUndefined();
    expect(result.packages).toBeUndefined();
  });

  it('returns error for invalid product_id', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'test-buyer-004',
      account: { brand: { domain: 'test.example' } },
      brand: { domain: 'test.example' },
      start_time: '2025-06-01T00:00:00Z',
      end_time: '2025-07-01T00:00:00Z',
      packages: [{
        product_id: 'nonexistent_product',
        pricing_option_id: 'whatever',
        budget: 5000,
        buyer_ref: 'pkg-1',
      }],
    });

    expect(result.errors).toBeDefined();
  });

  it('returns error for invalid pricing_option_id', async () => {
    const catalog = buildCatalog();
    const productId = catalog[0].product.product_id as string;
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'test-buyer-005',
      account: { brand: { domain: 'test.example' } },
      brand: { domain: 'test.example' },
      start_time: '2025-06-01T00:00:00Z',
      end_time: '2025-07-01T00:00:00Z',
      packages: [{
        product_id: productId,
        pricing_option_id: 'invalid_pricing',
        budget: 5000,
        buyer_ref: 'pkg-1',
      }],
    });

    expect(result.errors).toBeDefined();
    const errors = result.errors as Array<Record<string, unknown>>;
    expect(errors[0].message).toContain('Pricing option not found');
  });

  it('returns error when budget is below min_spend', async () => {
    // Find a product with min_spend_per_package
    const catalog = buildCatalog();
    let targetProduct: Record<string, unknown> | undefined;
    let targetPricing: Record<string, unknown> | undefined;

    for (const cp of catalog) {
      const opts = cp.product.pricing_options as Array<Record<string, unknown>>;
      const withMinSpend = opts.find(o => (o.min_spend_per_package as number) > 0);
      if (withMinSpend) {
        targetProduct = cp.product;
        targetPricing = withMinSpend;
        break;
      }
    }

    // Skip if no product has min_spend
    if (!targetProduct || !targetPricing) return;

    const minSpend = targetPricing.min_spend_per_package as number;
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'test-buyer-006',
      account: { brand: { domain: 'test.example' } },
      brand: { domain: 'test.example' },
      start_time: '2025-06-01T00:00:00Z',
      end_time: '2025-07-01T00:00:00Z',
      packages: [{
        product_id: targetProduct.product_id,
        pricing_option_id: targetPricing.pricing_option_id,
        budget: minSpend - 1,
        buyer_ref: 'pkg-1',
      }],
    });

    expect(result.errors).toBeDefined();
    const errors = result.errors as Array<Record<string, unknown>>;
    expect((errors[0].message as string)).toContain('below minimum spend');
  });

  it('resolves start_time "asap" to an ISO timestamp', async () => {
    const { productId, pricingOptionId } = getFirstProductAndPricing();
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'test-buyer-asap',
      account: { brand: { domain: 'test.example' } },
      brand: { domain: 'test.example' },
      start_time: 'asap',
      end_time: '2025-07-01T00:00:00Z',
      packages: [{
        product_id: productId,
        pricing_option_id: pricingOptionId,
        budget: 50000,
        buyer_ref: 'pkg-asap',
        start_time: 'asap',
        end_time: '2025-07-01T00:00:00Z',
      }],
    });

    expect(result.errors).toBeUndefined();
    const pkg = (result.packages as Array<Record<string, unknown>>)[0];
    // The start_time should be a real ISO timestamp, not 'asap'
    expect(pkg.start_time).not.toBe('asap');
    expect(new Date(pkg.start_time as string).toISOString()).toBeDefined();
  });
});

// ── sync_creatives handler ─────────────────────────────────────────

describe('sync_creatives handler', () => {
  beforeEach(() => {
    invalidateCache();
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
  });

  it('creates creatives and returns per-item results', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'sync_creatives', {
      account: { brand: { domain: 'test.example' } },
      creatives: [
        {
          creative_id: 'cr_test_001',
          format_id: { agent_url: TEST_AGENT_URL, id: 'display_300x250' },
          name: 'Test Creative',
        },
      ],
    });

    expect(result.errors).toBeUndefined();
    expect(result.sandbox).toBe(true);
    const creatives = result.creatives as Array<Record<string, unknown>>;
    expect(creatives).toHaveLength(1);
    // Per sync-creatives-response.json, each item requires creative_id and action
    expect(creatives[0].creative_id).toBe('cr_test_001');
    expect(creatives[0].action).toBe('created');
    expect(creatives[0].status).toBe('active');
  });

  it('returns "updated" action for existing creative', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const args = {
      account: { brand: { domain: 'test.example' } },
      creatives: [
        {
          creative_id: 'cr_test_002',
          format_id: { agent_url: TEST_AGENT_URL, id: 'display_300x250' },
        },
      ],
    };

    // First sync
    await simulateCallTool(server, 'sync_creatives', args);
    // Second sync (same session, same creative_id)
    const server2 = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server2, 'sync_creatives', args);

    const creatives = result.creatives as Array<Record<string, unknown>>;
    expect(creatives[0].action).toBe('updated');
  });

  it('generates creative_id when not provided', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'sync_creatives', {
      account: { brand: { domain: 'test.example' } },
      creatives: [
        {
          format_id: { agent_url: TEST_AGENT_URL, id: 'video_preroll' },
        },
      ],
    });

    const creatives = result.creatives as Array<Record<string, unknown>>;
    expect(typeof creatives[0].creative_id).toBe('string');
    expect((creatives[0].creative_id as string).length).toBeGreaterThan(0);
  });

  it('returns error for empty creatives array', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'sync_creatives', {
      account: { brand: { domain: 'test.example' } },
      creatives: [],
    });

    expect(result.errors).toBeDefined();
    // No creatives field on error response
    expect(result.creatives).toBeUndefined();
  });

  it('handles multiple creatives in a single sync', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'sync_creatives', {
      account: { brand: { domain: 'test.example' } },
      creatives: [
        { creative_id: 'cr_a', format_id: { agent_url: TEST_AGENT_URL, id: 'display_300x250' } },
        { creative_id: 'cr_b', format_id: { agent_url: TEST_AGENT_URL, id: 'video_preroll' } },
        { creative_id: 'cr_c', format_id: { agent_url: TEST_AGENT_URL, id: 'audio_spot' } },
      ],
    });

    const creatives = result.creatives as Array<Record<string, unknown>>;
    expect(creatives).toHaveLength(3);
    expect(creatives.map(c => c.creative_id)).toEqual(['cr_a', 'cr_b', 'cr_c']);
  });
});

// ── get_media_buys handler ─────────────────────────────────────────

describe('get_media_buys handler', () => {
  beforeEach(() => {
    invalidateCache();
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
  });

  it('returns empty array when no media buys exist', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_media_buys', {
      account: { brand: { domain: 'test.example' } },
    });

    expect(Array.isArray(result.media_buys)).toBe(true);
    expect((result.media_buys as unknown[]).length).toBe(0);
  });

  it('returns created media buys', async () => {
    const catalog = buildCatalog();
    const product = catalog[0].product;
    const pricingOptions = product.pricing_options as Array<Record<string, unknown>>;
    const account = { brand: { domain: 'getbuys.example' } };

    const server = createTrainingAgentServer(DEFAULT_CTX);

    // Create a media buy first
    await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'buyer-for-get',
      account,
      brand: { domain: 'getbuys.example' },
      start_time: '2025-06-01T00:00:00Z',
      end_time: '2025-07-01T00:00:00Z',
      packages: [{
        product_id: product.product_id,
        pricing_option_id: pricingOptions[0].pricing_option_id,
        budget: 10000,
        buyer_ref: 'pkg-for-get',
      }],
    });

    // Retrieve
    const server2 = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server2, 'get_media_buys', { account });

    const buys = result.media_buys as Array<Record<string, unknown>>;
    expect(buys.length).toBe(1);
    expect(buys[0].buyer_ref).toBe('buyer-for-get');
    expect(buys[0].status).toBe('active');
  });
});

// ── list_creatives handler ─────────────────────────────────────────

describe('list_creatives handler', () => {
  beforeEach(() => {
    invalidateCache();
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
  });

  it('returns synced creatives', async () => {
    const account = { brand: { domain: 'listcreatives.example' } };
    const server = createTrainingAgentServer(DEFAULT_CTX);

    await simulateCallTool(server, 'sync_creatives', {
      account,
      creatives: [
        { creative_id: 'cr_list_1', format_id: { agent_url: TEST_AGENT_URL, id: 'display_300x250' }, name: 'Test' },
      ],
    });

    const server2 = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server2, 'list_creatives', { account });

    const creatives = result.creatives as Array<Record<string, unknown>>;
    expect(creatives).toHaveLength(1);
    expect(creatives[0].creative_id).toBe('cr_list_1');
    expect(creatives[0].name).toBe('Test');
    expect(creatives[0].status).toBe('active');
    expect(creatives[0].format_id).toBeDefined();
  });
});

// ── update_media_buy handler ───────────────────────────────────────

describe('update_media_buy handler', () => {
  beforeEach(() => {
    invalidateCache();
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
  });

  it('updates package budget', async () => {
    const catalog = buildCatalog();
    const product = catalog[0].product;
    const pricingOptions = product.pricing_options as Array<Record<string, unknown>>;
    const account = { brand: { domain: 'update.example' } };

    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result: createResult } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'buyer-update',
      account,
      brand: { domain: 'update.example' },
      start_time: '2025-06-01T00:00:00Z',
      end_time: '2025-07-01T00:00:00Z',
      packages: [{
        product_id: product.product_id,
        pricing_option_id: pricingOptions[0].pricing_option_id,
        budget: 10000,
        buyer_ref: 'pkg-update',
      }],
    });

    const mediaBuyId = createResult.media_buy_id as string;
    const pkgId = ((createResult.packages as Array<Record<string, unknown>>)[0]).package_id as string;

    const server2 = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server2, 'update_media_buy', {
      account,
      media_buy_id: mediaBuyId,
      packages: [{ package_id: pkgId, budget: 20000 }],
    });

    const pkg = (result.packages as Array<Record<string, unknown>>)[0];
    expect(pkg.budget).toBe(20000);
  });

  it('returns error for nonexistent media buy', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'update_media_buy', {
      account: { brand: { domain: 'update.example' } },
      media_buy_id: 'nonexistent',
    });

    expect(result.errors).toBeDefined();
  });
});

// ── Channel coverage ───────────────────────────────────────────────

describe('channel coverage across publishers', () => {
  it('publishers collectively declare channels that are all valid enum values', () => {
    for (const pub of PUBLISHERS) {
      for (const ch of pub.channels) {
        expect(VALID_CHANNELS).toContain(ch);
      }
    }
  });

  it('publishers cover the core advertising channels', () => {
    const allChannels = new Set(PUBLISHERS.flatMap(p => p.channels));
    const coreChannels = [
      'display', 'olv', 'ctv', 'streaming_audio', 'podcast',
      'dooh', 'ooh', 'gaming', 'retail_media', 'social', 'influencer',
      'email', 'linear_tv',
    ];
    for (const ch of coreChannels) {
      expect(allChannels.has(ch)).toBe(true);
    }
  });
});

// ── Refine mode ────────────────────────────────────────────────────

describe('get_products refine mode', () => {
  beforeEach(() => {
    invalidateCache();
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
  });

  it('omits products by id', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const account = { brand: { domain: 'refine.example' } };

    // First call to populate session context
    const { result: initial } = await simulateCallTool(server, 'get_products', {
      buying_mode: 'wholesale',
      account,
    });
    const products = initial.products as Array<Record<string, unknown>>;
    const firstProductId = products[0].product_id as string;

    // Refine: omit the first product
    const server2 = createTrainingAgentServer(DEFAULT_CTX);
    const { result: refined } = await simulateCallTool(server2, 'get_products', {
      buying_mode: 'refine',
      account,
      refine: [{ scope: 'product', action: 'omit', id: firstProductId }],
    });

    const refinedProducts = refined.products as Array<Record<string, unknown>>;
    const refinedIds = refinedProducts.map(p => p.product_id);
    expect(refinedIds).not.toContain(firstProductId);
  });
});
