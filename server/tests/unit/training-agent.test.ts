import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildCatalog } from '../../src/training-agent/product-factory.js';
import { buildFormats, FORMAT_CHANNEL_MAP } from '../../src/training-agent/formats.js';
import { PUBLISHERS } from '../../src/training-agent/publishers.js';
import { SIGNAL_PROVIDERS, getAllSignals } from '../../src/training-agent/signal-providers.js';
import {
  getSession,
  sessionKeyFromArgs,
  clearSessions,
  startSessionCleanup,
  stopSessionCleanup,
  MAX_MEDIA_BUYS_PER_SESSION,
  MAX_CREATIVES_PER_SESSION,
} from '../../src/training-agent/state.js';
import {
  createTrainingAgentServer,
  invalidateCache,
} from '../../src/training-agent/task-handlers.js';
import { getAgentUrl } from '../../src/training-agent/config.js';
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
    // publisher_properties, format_ids, delivery_type, pricing_options

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

    it('has valid delivery_measurement when present', () => {
      for (const cp of catalog) {
        const dm = cp.product.delivery_measurement as Record<string, unknown> | undefined;
        if (dm) {
          expect(typeof dm.provider).toBe('string');
          expect((dm.provider as string).length).toBeGreaterThan(0);
        }
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

    it('every pricing option has model alias matching pricing_model', () => {
      for (const cp of catalog) {
        const opts = cp.product.pricing_options as Array<Record<string, unknown>>;
        for (const opt of opts) {
          expect(opt.model).toBe(opt.pricing_model);
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

// ── NovaMind AI publisher ──────────────────────────────────────────

describe('NovaMind AI publisher', () => {
  const novamind = PUBLISHERS.find(p => p.id === 'novamind')!;

  it('has vertical properties for travel, shopping, and wellness', () => {
    const propIds = novamind.properties.map(p => p.propertyId);
    expect(propIds).toContain('novamind_travel');
    expect(propIds).toContain('novamind_shopping');
    expect(propIds).toContain('novamind_wellness');
  });

  it('has CPA pricing with agent_session event type', () => {
    const cpa = novamind.pricingTemplates.find(t => t.model === 'cpa');
    expect(cpa).toBeDefined();
    expect(cpa!.eventType).toBe('custom');
    expect(cpa!.fixedPrice).toBeGreaterThan(0);
  });

  it('has flat_rate pricing for exclusive sponsorships', () => {
    const flatRate = novamind.pricingTemplates.find(t => t.model === 'flat_rate');
    expect(flatRate).toBeDefined();
    expect(flatRate!.fixedPrice).toBeGreaterThanOrEqual(50000);
    expect(flatRate!.minSpendPerPackage).toBeGreaterThanOrEqual(50000);
  });

  it('generates products that include the ai_sponsored_agent format', () => {
    const allProducts = buildCatalog();
    const novamindProducts = allProducts.filter(cp => cp.publisherId === 'novamind');
    expect(novamindProducts.length).toBeGreaterThan(0);

    const allFormatIds = novamindProducts.flatMap(cp => {
      const fids = cp.product.format_ids as Array<Record<string, unknown>>;
      return fids.map(f => f.id);
    });
    expect(allFormatIds).toContain('ai_sponsored_agent');
    expect(allFormatIds).toContain('ai_sponsored_recommendation');
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

describe('ai_sponsored_agent format', () => {
  const formats = buildFormats(TEST_AGENT_URL);
  const agentFormat = formats.find(f =>
    (f.format_id as Record<string, unknown>).id === 'ai_sponsored_agent',
  ) as Record<string, unknown>;

  it('exists in the format catalog', () => {
    expect(agentFormat).toBeDefined();
  });

  it('has two renders: agent_card and conversational', () => {
    const renders = agentFormat.renders as Array<Record<string, unknown>>;
    expect(renders.length).toBe(2);
    const roles = renders.map(r => r.role);
    expect(roles).toContain('agent_card');
    expect(roles).toContain('conversational');
  });

  it('requires system_prompt, agent_name, welcome_message, agent_icon, and click_url', () => {
    const assets = agentFormat.assets as Array<Record<string, unknown>>;
    const requiredIds = assets.filter(a => a.required === true).map(a => a.asset_id);
    expect(requiredIds).toContain('system_prompt');
    expect(requiredIds).toContain('agent_name');
    expect(requiredIds).toContain('welcome_message');
    expect(requiredIds).toContain('agent_icon');
    expect(requiredIds).toContain('click_url');
  });

  it('has optional knowledge_base URL asset', () => {
    const assets = agentFormat.assets as Array<Record<string, unknown>>;
    const kb = assets.find(a => a.asset_id === 'knowledge_base');
    expect(kb).toBeDefined();
    expect(kb!.required).toBe(false);
    expect(kb!.asset_type).toBe('url');
  });

  it('system_prompt has min_length and max_length requirements', () => {
    const assets = agentFormat.assets as Array<Record<string, unknown>>;
    const sp = assets.find(a => a.asset_id === 'system_prompt');
    const reqs = sp!.requirements as Record<string, unknown>;
    expect(reqs.min_length).toBe(50);
    expect(reqs.max_length).toBe(4000);
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
        { account: { brand: { domain: 'acme.example' }, operator: 'acme.example' } },
        'open',
      );
      expect(key).toBe('open:acme.example');
    });

    it('uses account_id when account has account_id form', () => {
      const key = sessionKeyFromArgs(
        { account: { account_id: 'acc_acme_001' } },
        'open',
      );
      expect(key).toBe('open:acc_acme_001');
    });

    it('uses top-level brand domain when account is absent', () => {
      const key = sessionKeyFromArgs(
        { brand: { domain: 'acme.example' } },
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
        { account: { brand: { domain: 'test.example' }, operator: 'test.example' } },
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
    expect(toolNames).toContain('get_signals');
    expect(toolNames).toContain('activate_signal');
    expect(toolNames).toContain('get_creative_delivery');
    expect(toolNames).toContain('sync_plans');
    expect(toolNames).toContain('check_governance');
    expect(toolNames).toContain('report_plan_outcome');
    expect(toolNames).toContain('get_plan_audit_logs');
    expect(toolNames).toContain('get_adcp_capabilities');
    expect(toolNames).toHaveLength(16);
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

  it('caps brief results at 5 most relevant products', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    // Use a broad term that matches many products
    const { result } = await simulateCallTool(server, 'get_products', {
      buying_mode: 'brief',
      brief: 'premium display video audio social search',
    });

    const products = result.products as Array<Record<string, unknown>>;
    // Broad terms match well over 5 catalog products, so the cap must be exercised
    expect(products.length).toEqual(5);
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
      account: { brand: { domain: 'test.example' }, operator: 'test.example' },
      brand: { domain: 'test.example' },
      start_time: '2027-06-01T00:00:00Z',
      end_time: '2027-07-01T00:00:00Z',
      packages: [{
        product_id: productId,
        pricing_option_id: pricingOptionId,
        budget: 50000,
        buyer_ref: 'pkg-buyer-001',
        start_time: '2027-06-01T00:00:00Z',
        end_time: '2027-07-01T00:00:00Z',
      }],
    });

    // Success response: media_buy_id, buyer_ref, packages (required per schema)
    expect(typeof result.media_buy_id).toBe('string');
    expect(result.buyer_ref).toBe('test-buyer-001');
    expect(Array.isArray(result.packages)).toBe(true);
    expect((result.packages as unknown[]).length).toBe(1);
    expect(result.sandbox).toBe(true);
    // Future dates → pending_activation status
    expect(result.status).toBe('pending_activation');
    // Error field should not be present on success
    expect(result.errors).toBeUndefined();
  });

  it('derives status from flight dates', async () => {
    const { productId, pricingOptionId } = getFirstProductAndPricing();

    // Past dates → completed
    const server1 = createTrainingAgentServer(DEFAULT_CTX);
    const { result: past } = await simulateCallTool(server1, 'create_media_buy', {
      buyer_ref: 'status-past',
      account: { brand: { domain: 'status.example' }, operator: 'status.example' },
      brand: { domain: 'status.example' },
      start_time: '2020-01-01T00:00:00Z',
      end_time: '2020-01-31T23:59:59Z',
      packages: [{ product_id: productId, pricing_option_id: pricingOptionId, budget: 50000, buyer_ref: 'p' }],
    });
    expect(past.status).toBe('completed');

    // Current dates → active
    const now = new Date();
    const start = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const server2 = createTrainingAgentServer(DEFAULT_CTX);
    const { result: active } = await simulateCallTool(server2, 'create_media_buy', {
      buyer_ref: 'status-active',
      account: { brand: { domain: 'status.example' }, operator: 'status.example' },
      brand: { domain: 'status.example' },
      start_time: start,
      end_time: end,
      packages: [{ product_id: productId, pricing_option_id: pricingOptionId, budget: 50000, buyer_ref: 'p' }],
    });
    expect(active.status).toBe('active');
  });

  it('returns package with required fields', async () => {
    const { productId, pricingOptionId } = getFirstProductAndPricing();
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'test-buyer-002',
      account: { brand: { domain: 'test.example' }, operator: 'test.example' },
      brand: { domain: 'test.example' },
      start_time: '2027-06-01T00:00:00Z',
      end_time: '2027-07-01T00:00:00Z',
      packages: [{
        product_id: productId,
        pricing_option_id: pricingOptionId,
        budget: 10000,
        buyer_ref: 'pkg-buyer-002',
        start_time: '2027-06-01T00:00:00Z',
        end_time: '2027-07-01T00:00:00Z',
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
      account: { brand: { domain: 'test.example' }, operator: 'test.example' },
      brand: { domain: 'test.example' },
      start_time: '2027-06-01T00:00:00Z',
      end_time: '2027-07-01T00:00:00Z',
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
      account: { brand: { domain: 'test.example' }, operator: 'test.example' },
      brand: { domain: 'test.example' },
      start_time: '2027-06-01T00:00:00Z',
      end_time: '2027-07-01T00:00:00Z',
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
      account: { brand: { domain: 'test.example' }, operator: 'test.example' },
      brand: { domain: 'test.example' },
      start_time: '2027-06-01T00:00:00Z',
      end_time: '2027-07-01T00:00:00Z',
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
      account: { brand: { domain: 'test.example' }, operator: 'test.example' },
      brand: { domain: 'test.example' },
      start_time: '2027-06-01T00:00:00Z',
      end_time: '2027-07-01T00:00:00Z',
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
      account: { brand: { domain: 'test.example' }, operator: 'test.example' },
      brand: { domain: 'test.example' },
      start_time: 'asap',
      end_time: '2027-07-01T00:00:00Z',
      packages: [{
        product_id: productId,
        pricing_option_id: pricingOptionId,
        budget: 50000,
        buyer_ref: 'pkg-asap',
        start_time: 'asap',
        end_time: '2027-07-01T00:00:00Z',
      }],
    });

    expect(result.errors).toBeUndefined();
    const pkg = (result.packages as Array<Record<string, unknown>>)[0];
    // The start_time should be a real ISO timestamp, not 'asap'
    expect(pkg.start_time).not.toBe('asap');
    expect(new Date(pkg.start_time as string).toISOString()).toBeDefined();
  });

  it('returns error when start_time is after end_time', async () => {
    const { productId, pricingOptionId } = getFirstProductAndPricing();
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'test-buyer-bad-dates',
      account: { brand: { domain: 'test.example' }, operator: 'test.example' },
      brand: { domain: 'test.example' },
      start_time: '2027-08-01T00:00:00Z',
      end_time: '2027-07-01T00:00:00Z',
      packages: [{
        product_id: productId,
        pricing_option_id: pricingOptionId,
        budget: 50000,
        buyer_ref: 'pkg-bad-dates',
      }],
    });
    expect(result.errors).toBeDefined();
    expect((result.errors as Array<Record<string, unknown>>)[0].message).toContain('before end_time');
  });

  it('returns error when bid_price is below floor_price', async () => {
    const catalog = buildCatalog();
    let targetProduct: Record<string, unknown> | undefined;
    let targetPricing: Record<string, unknown> | undefined;

    for (const cp of catalog) {
      const opts = cp.product.pricing_options as Array<Record<string, unknown>>;
      const withFloor = opts.find(o => (o.floor_price as number) > 0);
      if (withFloor) {
        targetProduct = cp.product;
        targetPricing = withFloor;
        break;
      }
    }
    if (!targetProduct || !targetPricing) return;

    const floorPrice = targetPricing.floor_price as number;
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'test-buyer-low-bid',
      account: { brand: { domain: 'test.example' }, operator: 'test.example' },
      brand: { domain: 'test.example' },
      start_time: '2027-06-01T00:00:00Z',
      end_time: '2027-07-01T00:00:00Z',
      packages: [{
        product_id: targetProduct.product_id,
        pricing_option_id: targetPricing.pricing_option_id,
        budget: 50000,
        bid_price: floorPrice - 0.01,
        buyer_ref: 'pkg-low-bid',
      }],
    });
    expect(result.errors).toBeDefined();
    expect((result.errors as Array<Record<string, unknown>>)[0].message).toContain('below floor price');
  });

  it('includes status field in create response', async () => {
    const { productId, pricingOptionId } = getFirstProductAndPricing();
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'test-buyer-status',
      account: { brand: { domain: 'test.example' }, operator: 'test.example' },
      brand: { domain: 'test.example' },
      start_time: '2027-06-01T00:00:00Z',
      end_time: '2027-07-01T00:00:00Z',
      packages: [{
        product_id: productId,
        pricing_option_id: pricingOptionId,
        budget: 50000,
        buyer_ref: 'pkg-status',
      }],
    });
    // Future dates → pending_activation (not active)
    expect(result.status).toBe('pending_activation');
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
  });

  it('returns "updated" action for existing creative', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const args = {
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
      creatives: [],
    });

    expect(result.errors).toBeDefined();
    // No creatives field on error response
    expect(result.creatives).toBeUndefined();
  });

  it('handles multiple creatives in a single sync', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'sync_creatives', {
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

  it('returns error for invalid format_id', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'sync_creatives', {
      creatives: [{
        creative_id: 'cr_bad_format',
        format_id: { agent_url: TEST_AGENT_URL, id: 'nonexistent_format' },
      }],
    });
    expect(result.errors).toBeDefined();
    expect((result.errors as Array<Record<string, unknown>>)[0].message).toContain('Unknown format_id');
  });

  it('processes creative-to-package assignments', async () => {
    const catalog = buildCatalog();
    const product = catalog[0].product;
    const pricingOptions = product.pricing_options as Array<Record<string, unknown>>;
    const server = createTrainingAgentServer(DEFAULT_CTX);

    // Create a media buy first
    const { result: buyResult } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'buyer-assign',
      account: { brand: { domain: 'assign.example' }, operator: 'assign.example' },
      brand: { domain: 'assign.example' },
      start_time: '2027-06-01T00:00:00Z',
      end_time: '2027-07-01T00:00:00Z',
      packages: [{
        product_id: product.product_id,
        pricing_option_id: pricingOptions[0].pricing_option_id,
        budget: 10000,
        buyer_ref: 'pkg-assign',
      }],
    });
    const mediaBuyId = buyResult.media_buy_id as string;
    const packageId = (buyResult.packages as Array<Record<string, unknown>>)[0].package_id as string;

    // Sync creative with assignment
    const server2 = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server2, 'sync_creatives', {
      account: { brand: { domain: 'assign.example' }, operator: 'assign.example' },
      creatives: [{
        creative_id: 'cr_to_assign',
        format_id: { agent_url: TEST_AGENT_URL, id: 'display_300x250' },
      }],
      assignments: [{
        media_buy_id: mediaBuyId,
        package_id: packageId,
        creative_id: 'cr_to_assign',
      }],
    });

    expect(result.errors).toBeUndefined();
    const assignments = result.assignments as Array<Record<string, unknown>>;
    expect(assignments).toHaveLength(1);
    expect(assignments[0].status).toBe('assigned');
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
    const { result } = await simulateCallTool(server, 'get_media_buys', {});

    expect(Array.isArray(result.media_buys)).toBe(true);
    expect((result.media_buys as unknown[]).length).toBe(0);
  });

  it('returns created media buys', async () => {
    const catalog = buildCatalog();
    const product = catalog[0].product;
    const pricingOptions = product.pricing_options as Array<Record<string, unknown>>;
    const server = createTrainingAgentServer(DEFAULT_CTX);

    // Create a media buy first
    await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'buyer-for-get',
      account: { brand: { domain: 'getbuys.example' }, operator: 'getbuys.example' },
      brand: { domain: 'getbuys.example' },
      start_time: '2027-06-01T00:00:00Z',
      end_time: '2027-07-01T00:00:00Z',
      packages: [{
        product_id: product.product_id,
        pricing_option_id: pricingOptions[0].pricing_option_id,
        budget: 10000,
        buyer_ref: 'pkg-for-get',
      }],
    });

    // Retrieve
    const server2 = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server2, 'get_media_buys', {
      account: { brand: { domain: 'getbuys.example' }, operator: 'getbuys.example' },
    });

    const buys = result.media_buys as Array<Record<string, unknown>>;
    expect(buys.length).toBe(1);
    expect(buys[0].buyer_ref).toBe('buyer-for-get');
    // Future dates => pending_activation status
    expect(buys[0].status).toBe('pending_activation');
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
    const account = { brand: { domain: 'listcreatives.example' }, operator: 'listcreatives.example' };
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
    expect(creatives[0].status).toBe('approved');
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
    const account = { brand: { domain: 'update.example' }, operator: 'update.example' };

    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result: createResult } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'buyer-update',
      account,
      brand: { domain: 'update.example' },
      start_time: '2027-06-01T00:00:00Z',
      end_time: '2027-07-01T00:00:00Z',
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
      media_buy_id: 'nonexistent',
    });

    expect(result.errors).toBeDefined();
  });

  it('warns when updating a nonexistent package', async () => {
    const catalog = buildCatalog();
    const product = catalog[0].product;
    const pricingOptions = product.pricing_options as Array<Record<string, unknown>>;
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result: createResult } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'buyer-warn',
      account: { brand: { domain: 'update-warn.example' }, operator: 'update-warn.example' },
      brand: { domain: 'update-warn.example' },
      start_time: '2027-06-01T00:00:00Z',
      end_time: '2027-07-01T00:00:00Z',
      packages: [{
        product_id: product.product_id,
        pricing_option_id: pricingOptions[0].pricing_option_id,
        budget: 10000,
      }],
    });

    const mediaBuyId = createResult.media_buy_id as string;

    const server2 = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server2, 'update_media_buy', {
      account: { brand: { domain: 'update-warn.example' }, operator: 'update-warn.example' },
      media_buy_id: mediaBuyId,
      packages: [{ package_id: 'nonexistent_pkg', budget: 5000 }],
    });

    expect(result.warnings).toBeDefined();
    expect((result.warnings as string[])[0]).toContain('Package not found: nonexistent_pkg');
  });
});

describe('update_media_buy end_time validation', () => {
  beforeEach(() => {
    invalidateCache();
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
  });

  it('rejects invalid end_time string', async () => {
    const catalog = buildCatalog();
    const product = catalog[0].product;
    const pricingOptions = product.pricing_options as Array<Record<string, unknown>>;
    const account = { brand: { domain: 'endtime.example' }, operator: 'endtime.example' };

    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result: createResult } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'endtime-buyer',
      account,
      brand: { domain: 'endtime.example' },
      start_time: '2027-06-01T00:00:00Z',
      end_time: '2027-07-01T00:00:00Z',
      packages: [{
        product_id: product.product_id,
        pricing_option_id: pricingOptions[0].pricing_option_id,
        budget: 50000,
        buyer_ref: 'pkg-et',
      }],
    });

    const mediaBuyId = createResult.media_buy_id as string;

    const server2 = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server2, 'update_media_buy', {
      account,
      media_buy_id: mediaBuyId,
      end_time: 'banana',
    });

    expect(result.errors).toBeDefined();
    expect((result.errors as Array<Record<string, unknown>>)[0].message).toContain('Invalid end_time');
  });
});

// ── Package-level date validation ────────────────────────────────────

describe('create_media_buy package-level date validation', () => {
  beforeEach(() => {
    invalidateCache();
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
  });

  it('rejects invalid package start_time', async () => {
    const catalog = buildCatalog();
    const product = catalog[0].product;
    const pricingOptions = product.pricing_options as Array<Record<string, unknown>>;
    const account = { brand: { domain: 'pkgdate.example' }, operator: 'pkgdate.example' };

    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'pkgdate-buyer',
      account,
      brand: { domain: 'pkgdate.example' },
      start_time: '2027-06-01T00:00:00Z',
      end_time: '2027-07-01T00:00:00Z',
      packages: [{
        product_id: product.product_id,
        pricing_option_id: pricingOptions[0].pricing_option_id,
        budget: 50000,
        buyer_ref: 'pkg-bad-start',
        start_time: 'not-a-date',
      }],
    });

    expect(result.errors).toBeDefined();
    expect((result.errors as Array<Record<string, unknown>>)[0].message).toContain('Invalid start_time');
  });

  it('rejects invalid package end_time', async () => {
    const catalog = buildCatalog();
    const product = catalog[0].product;
    const pricingOptions = product.pricing_options as Array<Record<string, unknown>>;
    const account = { brand: { domain: 'pkgdate2.example' }, operator: 'pkgdate2.example' };

    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'pkgdate2-buyer',
      account,
      brand: { domain: 'pkgdate2.example' },
      start_time: '2027-06-01T00:00:00Z',
      end_time: '2027-07-01T00:00:00Z',
      packages: [{
        product_id: product.product_id,
        pricing_option_id: pricingOptions[0].pricing_option_id,
        budget: 50000,
        buyer_ref: 'pkg-bad-end',
        end_time: 'banana',
      }],
    });

    expect(result.errors).toBeDefined();
    expect((result.errors as Array<Record<string, unknown>>)[0].message).toContain('Invalid end_time');
  });
});

// ── Paused package delivery ─────────────────────────────────────────

describe('paused package delivery', () => {
  beforeEach(() => {
    invalidateCache();
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
  });

  it('returns zero metrics for paused packages', async () => {
    const catalog = buildCatalog();
    const product = catalog[0].product;
    const pricingOptions = product.pricing_options as Array<Record<string, unknown>>;
    const account = { brand: { domain: 'paused.example' }, operator: 'paused.example' };

    // Create a buy with asap start so it has elapsed time
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result: createResult } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'buyer-paused',
      account,
      brand: { domain: 'paused.example' },
      start_time: 'asap',
      end_time: '2027-07-01T00:00:00Z',
      packages: [{
        product_id: product.product_id,
        pricing_option_id: pricingOptions[0].pricing_option_id,
        budget: 10000,
      }],
    });

    const mediaBuyId = createResult.media_buy_id as string;
    const pkgId = ((createResult.packages as Array<Record<string, unknown>>)[0]).package_id as string;

    // Pause the package
    const server2 = createTrainingAgentServer(DEFAULT_CTX);
    await simulateCallTool(server2, 'update_media_buy', {
      account,
      media_buy_id: mediaBuyId,
      packages: [{ package_id: pkgId, paused: true }],
    });

    // Get delivery
    const server3 = createTrainingAgentServer(DEFAULT_CTX);
    const { result: delivery } = await simulateCallTool(server3, 'get_media_buy_delivery', {
      account,
      media_buy_id: mediaBuyId,
    });

    // Schema-compliant structure: media_buy_deliveries[].by_package[]
    const deliveries = delivery.media_buy_deliveries as Array<Record<string, unknown>>;
    const buyDelivery = deliveries[0];
    expect(buyDelivery.media_buy_id).toBe(mediaBuyId);
    expect(buyDelivery.status).toBeDefined();
    expect(buyDelivery.totals).toBeDefined();

    const byPackage = buyDelivery.by_package as Array<Record<string, unknown>>;
    expect(byPackage[0].paused).toBe(true);
    expect(byPackage[0].spend).toBe(0);
    expect(byPackage[0].impressions).toBe(0);
    // Required per-package fields per schema
    expect(byPackage[0].pricing_model).toBeDefined();
    expect(byPackage[0].rate).toBeDefined();
    expect(byPackage[0].currency).toBeDefined();
  });
});

describe('delivery response schema compliance', () => {
  beforeEach(() => {
    invalidateCache();
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
  });

  it('matches the get-media-buy-delivery-response schema structure', async () => {
    const catalog = buildCatalog();
    const product = catalog[0].product;
    const pricingOptions = product.pricing_options as Array<Record<string, unknown>>;
    const account = { brand: { domain: 'schema.example' }, operator: 'schema.example' };

    // Create an active buy
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result: createResult } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'schema-buyer',
      account,
      brand: { domain: 'schema.example' },
      start_time: 'asap',
      end_time: '2027-07-01T00:00:00Z',
      packages: [{
        product_id: product.product_id,
        pricing_option_id: pricingOptions[0].pricing_option_id,
        budget: 50000,
        buyer_ref: 'pkg-schema',
      }],
    });

    const mediaBuyId = createResult.media_buy_id as string;

    // Get delivery
    const server2 = createTrainingAgentServer(DEFAULT_CTX);
    const { result: delivery } = await simulateCallTool(server2, 'get_media_buy_delivery', {
      account,
      media_buy_id: mediaBuyId,
    });

    // Top-level required fields per schema
    expect(delivery.reporting_period).toBeDefined();
    const rp = delivery.reporting_period as Record<string, unknown>;
    expect(rp.start).toBeDefined(); // schema uses 'start', not 'start_date'
    expect(rp.end).toBeDefined();   // schema uses 'end', not 'end_date'
    expect(delivery.currency).toBeDefined();
    expect(delivery.media_buy_deliveries).toBeDefined();

    // media_buy_deliveries item required fields
    const deliveries = delivery.media_buy_deliveries as Array<Record<string, unknown>>;
    expect(deliveries.length).toBe(1);
    const item = deliveries[0];
    expect(item.media_buy_id).toBe(mediaBuyId);
    expect(item.status).toBeDefined();
    expect(item.totals).toBeDefined();
    expect(item.by_package).toBeDefined();

    // totals required: spend
    const totals = item.totals as Record<string, unknown>;
    expect(typeof totals.spend).toBe('number');
    expect(typeof totals.impressions).toBe('number');

    // by_package item required: package_id, spend, pricing_model, rate, currency
    const byPkg = item.by_package as Array<Record<string, unknown>>;
    expect(byPkg.length).toBe(1);
    expect(byPkg[0].package_id).toBeDefined();
    expect(typeof byPkg[0].spend).toBe('number');
    expect(byPkg[0].pricing_model).toBeDefined();
    expect(typeof byPkg[0].rate).toBe('number');
    expect(byPkg[0].currency).toBeDefined();
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
      'email', 'linear_tv', 'search', 'radio', 'print',
    ];
    for (const ch of coreChannels) {
      expect(allChannels.has(ch)).toBe(true);
    }
  });
});

// ── Multi-currency and new features ───────────────────────────────

describe('multi-currency support', () => {
  it('has EUR pricing on Pinnacle News', () => {
    const pinnacle = PUBLISHERS.find(p => p.id === 'pinnacle_news')!;
    const eurPricing = pinnacle.pricingTemplates.filter(t => t.currency === 'EUR');
    expect(eurPricing.length).toBeGreaterThan(0);
  });

  it('has GBP pricing on StreetLevel Media', () => {
    const streetlevel = PUBLISHERS.find(p => p.id === 'streetlevel')!;
    const gbpPricing = streetlevel.pricingTemplates.filter(t => t.currency === 'GBP');
    expect(gbpPricing.length).toBeGreaterThan(0);
  });

  it('has EUR pricing on Viewpoint Sports', () => {
    const viewpoint = PUBLISHERS.find(p => p.id === 'viewpoint_sports')!;
    const eurPricing = viewpoint.pricingTemplates.filter(t => t.currency === 'EUR');
    expect(eurPricing.length).toBeGreaterThan(0);
  });
});

describe('time pricing model', () => {
  it('StreetLevel has time pricing', () => {
    const streetlevel = PUBLISHERS.find(p => p.id === 'streetlevel')!;
    const timePricing = streetlevel.pricingTemplates.find(t => t.model === 'time');
    expect(timePricing).toBeDefined();
    expect(timePricing!.timeParameters).toBeDefined();
    expect(timePricing!.timeParameters!.time_unit).toBe('week');
  });

  it('Meridian Print has time pricing', () => {
    const meridian = PUBLISHERS.find(p => p.id === 'meridian_print')!;
    const timePricing = meridian.pricingTemplates.find(t => t.model === 'time');
    expect(timePricing).toBeDefined();
    expect(timePricing!.timeParameters!.time_unit).toBe('month');
  });

  it('time pricing produces valid pricing options in products', () => {
    const catalog = buildCatalog();
    const streetlevelProducts = catalog.filter(cp => cp.publisherId === 'streetlevel');
    const allPricing = streetlevelProducts.flatMap(cp =>
      (cp.product.pricing_options as Array<Record<string, unknown>>),
    );
    const timePricing = allPricing.find(po => po.pricing_model === 'time');
    expect(timePricing).toBeDefined();
    expect(timePricing!.parameters).toBeDefined();
  });
});

describe('forecast data', () => {
  it('non-guaranteed products have forecast field', () => {
    const catalog = buildCatalog();
    const nonGuaranteed = catalog.filter(cp =>
      cp.product.delivery_type === 'non_guaranteed',
    );
    expect(nonGuaranteed.length).toBeGreaterThan(0);
    for (const cp of nonGuaranteed) {
      expect(cp.product.forecast).toBeDefined();
      const forecast = cp.product.forecast as Record<string, unknown>;
      expect(forecast.method).toBe('modeled');
      const points = forecast.points as Array<Record<string, unknown>>;
      expect(points.length).toBe(2);
    }
  });

  it('guaranteed products do not have forecast', () => {
    const catalog = buildCatalog();
    const guaranteed = catalog.filter(cp =>
      cp.product.delivery_type === 'guaranteed',
    );
    expect(guaranteed.length).toBeGreaterThan(0);
    for (const cp of guaranteed) {
      expect(cp.product.forecast).toBeUndefined();
    }
  });
});

describe('new publishers', () => {
  it('Crestline Radio covers radio and streaming_audio channels', () => {
    const crestline = PUBLISHERS.find(p => p.id === 'crestline_radio')!;
    expect(crestline).toBeDefined();
    expect(crestline.channels).toContain('radio');
    expect(crestline.channels).toContain('streaming_audio');
  });

  it('Meridian Print covers print and display channels', () => {
    const meridian = PUBLISHERS.find(p => p.id === 'meridian_print')!;
    expect(meridian).toBeDefined();
    expect(meridian.channels).toContain('print');
    expect(meridian.channels).toContain('display');
  });

  it('print_full_page format exists and maps to print channel', () => {
    expect(FORMAT_CHANNEL_MAP.print_full_page).toEqual(['print']);
  });

  it('radio_spot format exists and maps to radio channel', () => {
    expect(FORMAT_CHANNEL_MAP.radio_spot).toEqual(['radio']);
  });

  it('Crestline Radio products appear in catalog', () => {
    const catalog = buildCatalog();
    const crestlineProducts = catalog.filter(cp => cp.publisherId === 'crestline_radio');
    expect(crestlineProducts.length).toBeGreaterThan(0);
  });

  it('Meridian Print products appear in catalog', () => {
    const catalog = buildCatalog();
    const meridianProducts = catalog.filter(cp => cp.publisherId === 'meridian_print');
    expect(meridianProducts.length).toBeGreaterThan(0);
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
    const account = { brand: { domain: 'refine.example' }, operator: 'refine.example' };

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

  it('finds similar products with more_like_this', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const account = { brand: { domain: 'morelike.example' }, operator: 'morelike.example' };

    // Get wholesale catalog first to populate session context
    const { result: initial } = await simulateCallTool(server, 'get_products', {
      buying_mode: 'wholesale',
      account,
    });
    const products = initial.products as Array<Record<string, unknown>>;
    const sourceProduct = products[0];
    const sourceId = sourceProduct.product_id as string;
    const sourceChannels = sourceProduct.channels as string[];

    // Refine: more_like_this on the first product
    const server2 = createTrainingAgentServer(DEFAULT_CTX);
    const { result: refined } = await simulateCallTool(server2, 'get_products', {
      buying_mode: 'refine',
      account,
      refine: [{ scope: 'product', action: 'more_like_this', id: sourceId }],
    });

    const refinedProducts = refined.products as Array<Record<string, unknown>>;
    const refinedIds = refinedProducts.map(p => p.product_id);

    // Source product should be included
    expect(refinedIds).toContain(sourceId);

    // All returned products should share at least one channel with the source
    for (const p of refinedProducts) {
      const channels = p.channels as string[];
      const hasOverlap = channels.some(c => sourceChannels.includes(c));
      expect(hasOverlap).toBe(true);
    }

    // Should have more than just the source product
    expect(refinedProducts.length).toBeGreaterThan(1);
  });
});

// ── get_media_buy_delivery handler ──────────────────────────────────

describe('get_media_buy_delivery handler', () => {
  beforeEach(() => {
    invalidateCache();
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
  });

  it('returns not_found for nonexistent media buy', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_media_buy_delivery', {
      media_buy_id: 'mb_nonexistent',
    });

    expect(result.errors).toBeDefined();
    expect((result.errors as Array<Record<string, unknown>>)[0].code).toBe('not_found');
  });

  it('looks up by buyer_ref fallback', async () => {
    const catalog = buildCatalog();
    const product = catalog[0].product;
    const pricingOptions = product.pricing_options as Array<Record<string, unknown>>;
    const account = { brand: { domain: 'deliveryref.example' }, operator: 'deliveryref.example' };

    const server = createTrainingAgentServer(DEFAULT_CTX);
    await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'delivery-ref-test',
      account,
      brand: { domain: 'deliveryref.example' },
      start_time: '2025-01-01T00:00:00Z',
      end_time: '2025-12-31T00:00:00Z',
      packages: [{
        product_id: product.product_id,
        pricing_option_id: pricingOptions[0].pricing_option_id,
        budget: 50000,
        buyer_ref: 'pkg-dr',
      }],
    });

    // Look up delivery by buyer_ref instead of media_buy_id
    const server2 = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server2, 'get_media_buy_delivery', {
      account,
      media_buy_id: 'delivery-ref-test',
    });

    expect(result.errors).toBeUndefined();
    expect(result.media_buy_deliveries).toBeDefined();
  });

  it('returns delivery metrics for multi-package buy', async () => {
    const catalog = buildCatalog();
    const product = catalog[0].product;
    const pricingOptions = product.pricing_options as Array<Record<string, unknown>>;
    const account = { brand: { domain: 'deliverymulti.example' }, operator: 'deliverymulti.example' };

    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result: createResult } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'multi-pkg-delivery',
      account,
      brand: { domain: 'deliverymulti.example' },
      start_time: '2025-01-01T00:00:00Z',
      end_time: '2025-12-31T00:00:00Z',
      packages: [
        {
          product_id: product.product_id,
          pricing_option_id: pricingOptions[0].pricing_option_id,
          budget: 50000,
          buyer_ref: 'pkg-a',
        },
        {
          product_id: product.product_id,
          pricing_option_id: pricingOptions[0].pricing_option_id,
          budget: 30000,
          buyer_ref: 'pkg-b',
        },
      ],
    });

    const mediaBuyId = createResult.media_buy_id as string;

    const server2 = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server2, 'get_media_buy_delivery', {
      account,
      media_buy_id: mediaBuyId,
    });

    const deliveries = result.media_buy_deliveries as Array<Record<string, unknown>>;
    expect(deliveries).toHaveLength(1);
    const byPackage = deliveries[0].by_package as Array<Record<string, unknown>>;
    expect(byPackage).toHaveLength(2);
    expect(byPackage[0].buyer_ref).toBe('pkg-a');
    expect(byPackage[1].buyer_ref).toBe('pkg-b');

    // Totals should be the sum of package metrics
    const totals = deliveries[0].totals as Record<string, number>;
    const sumSpend = byPackage.reduce((s, p) => s + (p.spend as number), 0);
    expect(totals.spend).toBeCloseTo(sumSpend, 1);
  });

  it('returns zero delivery for future-dated buy', async () => {
    const catalog = buildCatalog();
    const product = catalog[0].product;
    const pricingOptions = product.pricing_options as Array<Record<string, unknown>>;
    const account = { brand: { domain: 'deliveryfuture.example' }, operator: 'deliveryfuture.example' };

    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result: createResult } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'future-delivery',
      account,
      brand: { domain: 'deliveryfuture.example' },
      start_time: '2028-01-01T00:00:00Z',
      end_time: '2028-12-31T00:00:00Z',
      packages: [{
        product_id: product.product_id,
        pricing_option_id: pricingOptions[0].pricing_option_id,
        budget: 50000,
        buyer_ref: 'pkg-future',
      }],
    });

    const mediaBuyId = createResult.media_buy_id as string;

    const server2 = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server2, 'get_media_buy_delivery', {
      account,
      media_buy_id: mediaBuyId,
    });

    const deliveries = result.media_buy_deliveries as Array<Record<string, unknown>>;
    const totals = deliveries[0].totals as Record<string, number>;
    expect(totals.spend).toBe(0);
    expect(totals.impressions).toBe(0);
    expect(totals.clicks).toBe(0);
  });
});

// ── Session limits ──────────────────────────────────────────────────

describe('session limits', () => {
  beforeEach(() => {
    invalidateCache();
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
  });

  it('rejects create_media_buy when session media buy limit reached', async () => {
    const catalog = buildCatalog();
    const product = catalog[0].product;
    const pricingOptions = product.pricing_options as Array<Record<string, unknown>>;
    const account = { brand: { domain: 'limit-mb.example' }, operator: 'limit-mb.example' };

    // Fill the session to the limit by directly manipulating state
    const sessionKey = sessionKeyFromArgs({ account }, 'open');
    const session = getSession(sessionKey);
    for (let i = 0; i < MAX_MEDIA_BUYS_PER_SESSION; i++) {
      session.mediaBuys.set(`mb_fill_${i}`, {
        mediaBuyId: `mb_fill_${i}`,
        buyerRef: `fill-${i}`,
        status: 'active',
        currency: 'USD',
        packages: [],
        startTime: '2027-01-01T00:00:00Z',
        endTime: '2027-12-31T00:00:00Z',
        accountRef: account,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      } as any);
    }

    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'one-too-many',
      account,
      brand: { domain: 'limit-mb.example' },
      start_time: '2027-06-01T00:00:00Z',
      end_time: '2027-07-01T00:00:00Z',
      packages: [{
        product_id: product.product_id,
        pricing_option_id: pricingOptions[0].pricing_option_id,
        budget: 50000,
        buyer_ref: 'pkg-limit',
      }],
    });

    expect(result.errors).toBeDefined();
    expect((result.errors as Array<Record<string, unknown>>)[0].code).toBe('limit_exceeded');
  });

  it('rejects sync_creatives when session creative limit reached', async () => {
    const account = { brand: { domain: 'limit-cr.example' }, operator: 'limit-cr.example' };

    // Fill creatives to the limit
    const sessionKey = sessionKeyFromArgs({ account }, 'open');
    const session = getSession(sessionKey);
    for (let i = 0; i < MAX_CREATIVES_PER_SESSION; i++) {
      session.creatives.set(`cr_fill_${i}`, {
        creativeId: `cr_fill_${i}`,
        status: 'active',
        syncedAt: new Date().toISOString(),
      } as any);
    }

    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'sync_creatives', {
      account,
      creatives: [{ name: 'one-too-many' }],
    });

    expect(result.errors).toBeDefined();
    expect((result.errors as Array<Record<string, unknown>>)[0].code).toBe('limit_exceeded');
  });
});

// ── Pause/resume on update_media_buy ────────────────────────────────

describe('update_media_buy pause/resume', () => {
  beforeEach(() => {
    invalidateCache();
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
  });

  it('pauses and resumes a package', async () => {
    const catalog = buildCatalog();
    const product = catalog[0].product;
    const pricingOptions = product.pricing_options as Array<Record<string, unknown>>;
    const account = { brand: { domain: 'pauseresume.example' }, operator: 'pauseresume.example' };

    // Create a media buy
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result: createResult } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'pause-test',
      account,
      brand: { domain: 'pauseresume.example' },
      start_time: '2027-01-01T00:00:00Z',
      end_time: '2027-12-31T00:00:00Z',
      packages: [{
        product_id: product.product_id,
        pricing_option_id: pricingOptions[0].pricing_option_id,
        budget: 50000,
        buyer_ref: 'pkg-pause',
      }],
    });

    const mediaBuyId = createResult.media_buy_id as string;
    const pkgs = createResult.packages as Array<Record<string, unknown>>;
    const packageId = pkgs[0].package_id as string;

    // Pause the package
    const server2 = createTrainingAgentServer(DEFAULT_CTX);
    const { result: pauseResult } = await simulateCallTool(server2, 'update_media_buy', {
      account,
      media_buy_id: mediaBuyId,
      packages: [{ package_id: packageId, paused: true }],
    });

    const pausedPkgs = pauseResult.packages as Array<Record<string, unknown>>;
    expect(pausedPkgs[0].paused).toBe(true);

    // Verify via get_media_buys
    const server3 = createTrainingAgentServer(DEFAULT_CTX);
    const { result: listResult } = await simulateCallTool(server3, 'get_media_buys', { account });
    const buys = listResult.media_buys as Array<Record<string, unknown>>;
    const buyPkgs = buys[0].packages as Array<Record<string, unknown>>;
    expect(buyPkgs[0].paused).toBe(true);

    // Resume the package
    const server4 = createTrainingAgentServer(DEFAULT_CTX);
    const { result: resumeResult } = await simulateCallTool(server4, 'update_media_buy', {
      account,
      media_buy_id: mediaBuyId,
      packages: [{ package_id: packageId, paused: false }],
    });

    const resumedPkgs = resumeResult.packages as Array<Record<string, unknown>>;
    expect(resumedPkgs[0].paused).toBe(false);
  });
});

// ── Multi-error collection in create_media_buy ──────────────────────

describe('create_media_buy multi-error collection', () => {
  beforeEach(() => {
    invalidateCache();
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
  });

  it('collects errors from multiple invalid packages', async () => {
    const catalog = buildCatalog();
    const product = catalog[0].product;
    const pricingOptions = product.pricing_options as Array<Record<string, unknown>>;
    const account = { brand: { domain: 'multierr.example' }, operator: 'multierr.example' };

    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'multi-err-buyer',
      account,
      brand: { domain: 'multierr.example' },
      start_time: '2027-06-01T00:00:00Z',
      end_time: '2027-07-01T00:00:00Z',
      packages: [
        {
          product_id: 'nonexistent_product_1',
          pricing_option_id: pricingOptions[0].pricing_option_id,
          budget: 50000,
          buyer_ref: 'pkg-bad-1',
        },
        {
          product_id: 'nonexistent_product_2',
          pricing_option_id: pricingOptions[0].pricing_option_id,
          budget: 50000,
          buyer_ref: 'pkg-bad-2',
        },
        {
          product_id: product.product_id,
          pricing_option_id: 'nonexistent_pricing',
          budget: 50000,
          buyer_ref: 'pkg-bad-3',
        },
      ],
    });

    const errors = result.errors as Array<Record<string, unknown>>;
    expect(errors).toBeDefined();
    // At minimum: 2 bad product IDs + 1 bad pricing option = 3 errors
    expect(errors.length).toBeGreaterThanOrEqual(3);
    // Each error should identify the package
    expect(errors[0].message).toContain('pkg-bad-1');
    expect(errors[1].message).toContain('pkg-bad-2');
    expect(errors[2].message).toContain('pkg-bad-3');
  });

  it('rejects negative budget', async () => {
    const catalog = buildCatalog();
    const product = catalog[0].product;
    const pricingOptions = product.pricing_options as Array<Record<string, unknown>>;
    const account = { brand: { domain: 'negbudget.example' }, operator: 'negbudget.example' };

    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'neg-budget-buyer',
      account,
      brand: { domain: 'negbudget.example' },
      start_time: '2027-06-01T00:00:00Z',
      end_time: '2027-07-01T00:00:00Z',
      packages: [{
        product_id: product.product_id,
        pricing_option_id: pricingOptions[0].pricing_option_id,
        budget: -1000,
        buyer_ref: 'pkg-neg',
      }],
    });

    expect(result.errors).toBeDefined();
    const errors = result.errors as Array<Record<string, unknown>>;
    expect(errors[0].message).toContain('non-negative');
  });
});

// ── update_media_buy budget validation ──────────────────────────────

describe('update_media_buy budget validation', () => {
  beforeEach(() => {
    invalidateCache();
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
  });

  it('rejects negative budget on update', async () => {
    const catalog = buildCatalog();
    const product = catalog[0].product;
    const pricingOptions = product.pricing_options as Array<Record<string, unknown>>;
    const account = { brand: { domain: 'negupdate.example' }, operator: 'negupdate.example' };

    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result: createResult } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'negupdate-buyer',
      account,
      brand: { domain: 'negupdate.example' },
      start_time: '2027-06-01T00:00:00Z',
      end_time: '2027-07-01T00:00:00Z',
      packages: [{
        product_id: product.product_id,
        pricing_option_id: pricingOptions[0].pricing_option_id,
        budget: 50000,
        buyer_ref: 'pkg-nu',
      }],
    });

    const mediaBuyId = createResult.media_buy_id as string;
    const pkgs = createResult.packages as Array<Record<string, unknown>>;
    const packageId = pkgs[0].package_id as string;

    const server2 = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server2, 'update_media_buy', {
      account,
      media_buy_id: mediaBuyId,
      packages: [{ package_id: packageId, budget: -500 }],
    });

    expect(result.errors).toBeDefined();
    expect((result.errors as Array<Record<string, unknown>>)[0].message).toContain('non-negative');
  });
});

// ── Signal provider catalog tests ─────────────────────────────────

describe('SIGNAL_PROVIDERS', () => {
  it('has at least 5 providers covering different types', () => {
    expect(SIGNAL_PROVIDERS.length).toBeGreaterThanOrEqual(5);
    const types = new Set(SIGNAL_PROVIDERS.map(p => p.providerType));
    expect(types).toContain('data_provider');
    expect(types).toContain('retailer');
    expect(types).toContain('publisher');
    expect(types).toContain('identity');
    expect(types).toContain('geo');
    expect(types).toContain('cdp');
  });

  it('every provider has at least 3 signals', () => {
    for (const provider of SIGNAL_PROVIDERS) {
      expect(provider.signals.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('every signal has required fields', () => {
    for (const signal of getAllSignals()) {
      expect(signal.signalAgentSegmentId).toBeTruthy();
      expect(signal.name).toBeTruthy();
      expect(signal.description).toBeTruthy();
      expect(['binary', 'categorical', 'numeric']).toContain(signal.valueType);
      expect(['marketplace', 'custom', 'owned']).toContain(signal.signalType);
      expect(signal.coveragePercentage).toBeGreaterThanOrEqual(0);
      expect(signal.coveragePercentage).toBeLessThanOrEqual(100);
      expect(signal.pricingOptions.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('categorical signals have categories array', () => {
    for (const signal of getAllSignals()) {
      if (signal.valueType === 'categorical') {
        expect(signal.categories).toBeDefined();
        expect(signal.categories!.length).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('numeric signals have range with min and max', () => {
    for (const signal of getAllSignals()) {
      if (signal.valueType === 'numeric') {
        expect(signal.range).toBeDefined();
        expect(signal.range!.min).toBeDefined();
        expect(signal.range!.max).toBeDefined();
        expect(signal.range!.max).toBeGreaterThan(signal.range!.min);
      }
    }
  });

  it('signal IDs are unique across all providers', () => {
    const ids = getAllSignals().map(s => s.signalAgentSegmentId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('pricing option IDs are unique within each signal', () => {
    for (const signal of getAllSignals()) {
      const ids = signal.pricingOptions.map(po => po.pricingOptionId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('every pricing option has valid model and currency', () => {
    for (const signal of getAllSignals()) {
      for (const po of signal.pricingOptions) {
        expect(['cpm', 'percent_of_media', 'flat_fee']).toContain(po.model);
        expect(po.currency).toBeTruthy();
        if (po.model === 'cpm') expect(po.cpm).toBeGreaterThan(0);
        if (po.model === 'flat_fee') {
          expect(po.amount).toBeGreaterThan(0);
          expect(po.period).toBeTruthy();
        }
        if (po.model === 'percent_of_media') {
          expect(po.percent).toBeGreaterThan(0);
          expect(po.percent).toBeLessThanOrEqual(100);
        }
      }
    }
  });
});

// ── get_signals handler tests ─────────────────────────────────────

describe('get_signals handler', () => {
  const account = { brand: { domain: 'signal-test.example' }, operator: 'signal-test.example' };

  beforeEach(() => {
    clearSessions();
    invalidateCache();
  });

  afterEach(() => {
    clearSessions();
    stopSessionCleanup();
  });

  it('returns error when neither signal_spec nor signal_ids provided', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_signals', { account });
    expect(result.errors).toBeDefined();
    expect((result.errors as Array<Record<string, unknown>>)[0].message).toContain('signal_spec or signal_ids');
  });

  it('discovers signals by natural language spec', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_signals', {
      account,
      signal_spec: 'automotive purchase intent',
    });

    expect(result.sandbox).toBe(true);
    const signals = result.signals as Array<Record<string, unknown>>;
    expect(signals.length).toBeGreaterThan(0);
    // Should find automotive-related signals
    const hasAuto = signals.some(s =>
      (s.name as string).toLowerCase().includes('auto') ||
      (s.name as string).toLowerCase().includes('ev') ||
      (s.name as string).toLowerCase().includes('vehicle'),
    );
    expect(hasAuto).toBe(true);
  });

  it('looks up signals by exact ID', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_signals', {
      account,
      signal_ids: [{ id: 'trident_likely_ev_buyers' }],
    });

    const signals = result.signals as Array<Record<string, unknown>>;
    expect(signals.length).toBe(1);
    expect(signals[0].signal_agent_segment_id).toBe('trident_likely_ev_buyers');
    expect(signals[0].name).toBe('Likely EV Buyers');
  });

  it('returns schema-compliant signal objects', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_signals', {
      account,
      signal_spec: 'loyalty',
    });

    const signals = result.signals as Array<Record<string, unknown>>;
    expect(signals.length).toBeGreaterThan(0);

    for (const signal of signals) {
      expect(signal.signal_agent_segment_id).toBeTruthy();
      expect(signal.name).toBeTruthy();
      expect(signal.description).toBeTruthy();
      expect(signal.signal_type).toBeTruthy();
      expect(signal.data_provider).toBeTruthy();
      expect(signal.coverage_percentage).toBeDefined();
      expect(signal.deployments).toBeDefined();
      expect((signal.deployments as unknown[]).length).toBeGreaterThan(0);
      expect(signal.pricing_options).toBeDefined();
      expect((signal.pricing_options as unknown[]).length).toBeGreaterThan(0);

      // signal_id with catalog source
      const signalId = signal.signal_id as Record<string, unknown>;
      expect(signalId.source).toBe('catalog');
      expect(signalId.data_provider_domain).toBeTruthy();
    }
  });

  it('includes value type metadata for categorical signals', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_signals', {
      account,
      signal_ids: [{ id: 'keystone_household_income' }],
    });

    const signals = result.signals as Array<Record<string, unknown>>;
    expect(signals.length).toBe(1);
    expect(signals[0].value_type).toBe('categorical');
    expect(signals[0].categories).toBeDefined();
    expect((signals[0].categories as string[]).length).toBeGreaterThan(0);
  });

  it('includes range for numeric signals', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_signals', {
      account,
      signal_ids: [{ id: 'trident_purchase_propensity' }],
    });

    const signals = result.signals as Array<Record<string, unknown>>;
    expect(signals.length).toBe(1);
    expect(signals[0].value_type).toBe('numeric');
    const range = signals[0].range as Record<string, number>;
    expect(range.min).toBe(0);
    expect(range.max).toBe(1);
  });

  it('filters by max_cpm', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_signals', {
      account,
      signal_spec: 'audience',
      filters: { max_cpm: 2.0 },
    });

    const signals = result.signals as Array<Record<string, unknown>>;
    for (const signal of signals) {
      const options = signal.pricing_options as Array<Record<string, unknown>>;
      const hasCheapCpm = options.some(po => po.model === 'cpm' && (po.cpm as number) <= 2.0);
      expect(hasCheapCpm).toBe(true);
    }
  });

  it('filters by data_providers', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_signals', {
      account,
      signal_spec: 'purchase',
      filters: { data_providers: ['ShopGrid Shopper Insights'] },
    });

    const signals = result.signals as Array<Record<string, unknown>>;
    for (const signal of signals) {
      expect(signal.data_provider).toBe('ShopGrid Shopper Insights');
    }
  });

  it('filters by catalog_types', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_signals', {
      account,
      signal_spec: 'customer',
      filters: { catalog_types: ['custom'] },
    });

    const signals = result.signals as Array<Record<string, unknown>>;
    for (const signal of signals) {
      expect(signal.signal_type).toBe('custom');
    }
  });

  it('caps results at max_results', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_signals', {
      account,
      signal_spec: 'the',
      max_results: 3,
    });

    const signals = result.signals as Array<Record<string, unknown>>;
    expect(signals.length).toBeLessThanOrEqual(3);
  });

  it('expands synonyms so "geographic audience" finds geo signals', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_signals', {
      account,
      signal_spec: 'geographic audience',
    });

    const signals = result.signals as Array<Record<string, unknown>>;
    expect(signals.length).toBeGreaterThan(0);
    const hasGeo = signals.some(s =>
      (s.data_provider as string).toLowerCase().includes('meridian') ||
      (s.data_provider as string).toLowerCase().includes('geo'),
    );
    expect(hasGeo).toBe(true);
  });

  it('expands synonyms so "location targeting" finds geo signals', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_signals', {
      account,
      signal_spec: 'location targeting',
    });

    const signals = result.signals as Array<Record<string, unknown>>;
    expect(signals.length).toBeGreaterThan(0);
  });

  it('returns identity scope note when searching for identity resolution', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_signals', {
      account,
      signal_spec: 'identity resolution',
    });

    expect(result.note).toBeDefined();
    expect(result.note as string).toContain('identity resolution');
  });

  it('returns credit scope note when searching for credit score', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_signals', {
      account,
      signal_spec: 'credit score segments',
    });

    expect(result.note).toBeDefined();
    expect(result.note as string).toContain('credit-derived');
    expect(result.note as string).toContain('FCRA');
    // Should still return credit-related signals
    const signals = result.signals as Array<Record<string, unknown>>;
    expect(signals.length).toBeGreaterThan(0);
  });

  it('expands synonyms so "shopper brand loyalty" finds retail signals', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_signals', {
      account,
      signal_spec: 'shopper brand loyalty',
    });

    const signals = result.signals as Array<Record<string, unknown>>;
    expect(signals.length).toBeGreaterThan(0);
    const hasRetail = signals.some(s =>
      (s.data_provider as string).toLowerCase().includes('shopgrid'),
    );
    expect(hasRetail).toBe(true);
  });

  it('expands synonyms so "household income demographic" finds identity signals', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_signals', {
      account,
      signal_spec: 'household income demographic',
    });

    const signals = result.signals as Array<Record<string, unknown>>;
    expect(signals.length).toBeGreaterThan(0);
    const hasKeystone = signals.some(s =>
      (s.data_provider as string).toLowerCase().includes('keystone'),
    );
    expect(hasKeystone).toBe(true);
  });

  it('finds new geo signals like dwell time', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_signals', {
      account,
      signal_ids: [{ id: 'meridian_dwell_time' }],
    });

    const signals = result.signals as Array<Record<string, unknown>>;
    expect(signals.length).toBe(1);
    expect(signals[0].value_type).toBe('numeric');
    const range = signals[0].range as Record<string, number>;
    expect(range.min).toBe(0);
    expect(range.max).toBe(120);
  });

  it('finds new retail signals like brand affinity', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_signals', {
      account,
      signal_ids: [{ id: 'shopgrid_brand_affinity' }],
    });

    const signals = result.signals as Array<Record<string, unknown>>;
    expect(signals.length).toBe(1);
    expect(signals[0].value_type).toBe('categorical');
    expect(signals[0].categories).toBeDefined();
    expect((signals[0].categories as string[])).toContain('loyal');
  });

  it('shows is_live false for unactivated signals', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_signals', {
      account,
      signal_ids: [{ id: 'trident_likely_ev_buyers' }],
    });

    const signals = result.signals as Array<Record<string, unknown>>;
    const deployments = signals[0].deployments as Array<Record<string, unknown>>;
    expect(deployments[0].is_live).toBe(false);
    expect(deployments[0].estimated_activation_duration_minutes).toBe(0);
    expect(deployments[0].activation_key).toBeUndefined();
  });
});

// ── activate_signal handler tests ─────────────────────────────────

describe('activate_signal handler', () => {
  const account = { brand: { domain: 'signal-test.example' }, operator: 'signal-test.example' };

  beforeEach(() => {
    clearSessions();
    invalidateCache();
  });

  afterEach(() => {
    clearSessions();
    stopSessionCleanup();

    stopSessionCleanup();
  });

  it('activates a signal and returns deployment with activation key', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'activate_signal', {
      account,
      signal_agent_segment_id: 'trident_likely_ev_buyers',
      pricing_option_id: 'po_trident_ev_cpm',
      destinations: [{ type: 'agent', agent_url: 'https://test.example' }],
    });

    expect(result.sandbox).toBe(true);
    expect(result.errors).toBeUndefined();
    const deployments = result.deployments as Array<Record<string, unknown>>;
    expect(deployments.length).toBe(1);
    expect(deployments[0].is_live).toBe(true);
    expect(deployments[0].deployed_at).toBeTruthy();

    const key = deployments[0].activation_key as Record<string, unknown>;
    expect(key.type).toBe('key_value');
    expect(key.key).toBe('audience_segment');
    expect(key.value).toBe('trident_likely_ev_buyers');
  });

  it('returns error for nonexistent signal', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'activate_signal', {
      account,
      signal_agent_segment_id: 'nonexistent_signal',
      destinations: [{ type: 'agent', agent_url: 'https://test.example' }],
    });

    expect(result.errors).toBeDefined();
    expect((result.errors as Array<Record<string, unknown>>)[0].code).toBe('SIGNAL_AGENT_SEGMENT_NOT_FOUND');
  });

  it('returns error for invalid pricing option', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'activate_signal', {
      account,
      signal_agent_segment_id: 'trident_likely_ev_buyers',
      pricing_option_id: 'invalid_pricing',
      destinations: [{ type: 'agent', agent_url: 'https://test.example' }],
    });

    expect(result.errors).toBeDefined();
    expect((result.errors as Array<Record<string, unknown>>)[0].code).toBe('INVALID_PRICING_MODEL');
  });

  it('returns error when destinations is empty', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'activate_signal', {
      account,
      signal_agent_segment_id: 'trident_likely_ev_buyers',
      destinations: [],
    });

    expect(result.errors).toBeDefined();
    expect((result.errors as Array<Record<string, unknown>>)[0].message).toContain('destinations');
  });

  it('activated signal shows is_live true in subsequent get_signals', async () => {
    // Activate — use getAgentUrl() so the destination matches what get_signals looks up
    const server1 = createTrainingAgentServer(DEFAULT_CTX);
    await simulateCallTool(server1, 'activate_signal', {
      account,
      signal_agent_segment_id: 'shopgrid_category_buyer',
      pricing_option_id: 'po_shopgrid_cat_cpm',
      destinations: [{ type: 'agent', agent_url: getAgentUrl() }],
    });

    // Query — same account so same session
    const server2 = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server2, 'get_signals', {
      account,
      signal_ids: [{ id: 'shopgrid_category_buyer' }],
    });

    const signals = result.signals as Array<Record<string, unknown>>;
    const deployments = signals[0].deployments as Array<Record<string, unknown>>;
    expect(deployments[0].is_live).toBe(true);
    expect(deployments[0].activation_key).toBeDefined();
  });

  it('deactivates a signal', async () => {
    const server1 = createTrainingAgentServer(DEFAULT_CTX);
    // Activate first
    await simulateCallTool(server1, 'activate_signal', {
      account,
      signal_agent_segment_id: 'meridian_competitor_visitors',
      destinations: [{ type: 'agent', agent_url: TEST_AGENT_URL }],
    });

    // Deactivate
    const server2 = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server2, 'activate_signal', {
      account,
      signal_agent_segment_id: 'meridian_competitor_visitors',
      action: 'deactivate',
      destinations: [{ type: 'agent', agent_url: TEST_AGENT_URL }],
    });

    const deployments = result.deployments as Array<Record<string, unknown>>;
    expect(deployments[0].is_live).toBe(false);

    // Verify it shows inactive in get_signals
    const server3 = createTrainingAgentServer(DEFAULT_CTX);
    const { result: getResult } = await simulateCallTool(server3, 'get_signals', {
      account,
      signal_ids: [{ id: 'meridian_competitor_visitors' }],
    });

    const signals = getResult.signals as Array<Record<string, unknown>>;
    const deps = signals[0].deployments as Array<Record<string, unknown>>;
    expect(deps[0].is_live).toBe(false);
  });

  it('handles platform destinations', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'activate_signal', {
      account,
      signal_agent_segment_id: 'keystone_household_income',
      pricing_option_id: 'po_keystone_inc_cpm',
      destinations: [{ type: 'platform', platform: 'the-trade-desk', account: 'agency-123' }],
    });

    const deployments = result.deployments as Array<Record<string, unknown>>;
    expect(deployments[0].type).toBe('platform');
    expect(deployments[0].platform).toBe('the-trade-desk');
    expect(deployments[0].account).toBe('agency-123');
    expect(deployments[0].is_live).toBe(true);
  });
});

// ── get_creative_delivery handler tests ───────────────────────────

describe('get_creative_delivery handler', () => {
  beforeEach(() => {
    clearSessions();
    invalidateCache();
  });

  afterEach(() => {
    clearSessions();
    stopSessionCleanup();
  });

  it('returns validation error when no scoping filter provided', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_creative_delivery', {});

    expect(result.errors).toBeDefined();
    expect((result.errors as Array<Record<string, unknown>>)[0].code).toBe('validation_error');
  });

  it('returns empty creatives for unknown media buy', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_creative_delivery', {
      media_buy_ids: ['mb_nonexistent'],
    });

    expect(result.errors).toBeUndefined();
    expect(result.creatives).toEqual([]);
    expect(result.currency).toBe('USD');
    expect(result.reporting_period).toBeDefined();
  });

  it('returns variant-level delivery for creatives assigned to a media buy', async () => {
    const catalog = buildCatalog();
    const product = catalog[0].product;
    const pricingOptions = product.pricing_options as Array<Record<string, unknown>>;
    const account = { brand: { domain: 'creativedel.example' }, operator: 'creativedel.example' };

    const server = createTrainingAgentServer(DEFAULT_CTX);

    // Create a media buy
    const { result: buyResult } = await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'cd-test',
      account,
      brand: { domain: 'creativedel.example' },
      start_time: '2025-01-01T00:00:00Z',
      end_time: '2025-12-31T00:00:00Z',
      packages: [{
        product_id: product.product_id,
        pricing_option_id: pricingOptions[0].pricing_option_id,
        budget: 10000,
        buyer_ref: 'pkg-cd',
      }],
    });

    const mediaBuyId = buyResult.media_buy_id as string;
    const pkgs = buyResult.packages as Array<Record<string, unknown>>;
    const packageId = pkgs[0].package_id as string;

    // Sync a creative with assignment to the package
    const { result: syncResult } = await simulateCallTool(server, 'sync_creatives', {
      account,
      creatives: [{
        creative_id: 'test_creative_1',
        name: 'Test Creative',
        format_id: { agent_url: TEST_AGENT_URL, id: 'display_300x250' },
        assets: { headline: { asset_type: 'text', content: 'Hello' } },
      }],
      assignments: [{ media_buy_id: mediaBuyId, package_id: packageId, creative_id: 'test_creative_1' }],
    });

    expect(syncResult.errors).toBeUndefined();

    // Get creative delivery
    const { result } = await simulateCallTool(server, 'get_creative_delivery', {
      account,
      media_buy_ids: [mediaBuyId],
      max_variants: 2,
    });

    expect(result.errors).toBeUndefined();
    expect(result.currency).toBe('USD');
    expect(result.reporting_period).toBeDefined();
    const creatives = result.creatives as Array<Record<string, unknown>>;
    expect(creatives.length).toBe(1);

    const creative = creatives[0];
    expect(creative.creative_id).toBe('test_creative_1');
    expect(creative.media_buy_id).toBe(mediaBuyId);
    expect(creative.variant_count).toBeGreaterThan(0);

    const variants = creative.variants as Array<Record<string, unknown>>;
    expect(variants.length).toBeGreaterThan(0);

    // Each variant should have required fields
    const variant = variants[0];
    expect(variant.variant_id).toBeDefined();
    expect(variant.generation_context).toBeDefined();
    expect(variant.manifest).toBeDefined();
    expect(typeof variant.impressions).toBe('number');
    expect(typeof variant.spend).toBe('number');
    expect(typeof variant.ctr).toBe('number');

    // Totals should be present
    const totals = creative.totals as Record<string, unknown>;
    expect(typeof totals.impressions).toBe('number');
    expect(typeof totals.spend).toBe('number');
  });

  it('returns deterministic results for the same creative', async () => {
    const catalog = buildCatalog();
    const product = catalog[0].product;
    const pricingOptions = product.pricing_options as Array<Record<string, unknown>>;
    const account = { brand: { domain: 'deterministic.example' }, operator: 'deterministic.example' };

    const server = createTrainingAgentServer(DEFAULT_CTX);

    await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'det-test',
      account,
      brand: { domain: 'deterministic.example' },
      start_time: '2025-01-01T00:00:00Z',
      end_time: '2025-12-31T00:00:00Z',
      packages: [{
        product_id: product.product_id,
        pricing_option_id: pricingOptions[0].pricing_option_id,
        budget: 10000,
        buyer_ref: 'pkg-det',
      }],
    });

    const { result: buyResult } = await simulateCallTool(server, 'get_media_buys', { account });
    const buys = buyResult.media_buys as Array<Record<string, unknown>>;
    const mediaBuyId = buys[0].media_buy_id as string;
    const mbPkgs = (buys[0] as Record<string, unknown>).packages as Array<Record<string, unknown>>;
    const mbPackageId = mbPkgs[0].package_id as string;

    await simulateCallTool(server, 'sync_creatives', {
      account,
      creatives: [{
        creative_id: 'stable_creative',
        name: 'Stable',
        format_id: { agent_url: TEST_AGENT_URL, id: 'display_300x250' },
        assets: { headline: { asset_type: 'text', content: 'Stable' } },
      }],
      assignments: [{ media_buy_id: mediaBuyId, package_id: mbPackageId, creative_id: 'stable_creative' }],
    });

    // Call twice and verify same results
    const { result: r1 } = await simulateCallTool(server, 'get_creative_delivery', {
      account,
      media_buy_ids: [mediaBuyId],
    });
    const { result: r2 } = await simulateCallTool(server, 'get_creative_delivery', {
      account,
      media_buy_ids: [mediaBuyId],
    });

    const c1 = (r1.creatives as Array<Record<string, unknown>>)[0];
    const c2 = (r2.creatives as Array<Record<string, unknown>>)[0];
    const t1 = c1.totals as Record<string, unknown>;
    const t2 = c2.totals as Record<string, unknown>;

    expect(t1.impressions).toBe(t2.impressions);
    expect(t1.spend).toBe(t2.spend);
    expect(t1.clicks).toBe(t2.clicks);
  });

  it('looks up by buyer_refs', async () => {
    const catalog = buildCatalog();
    const product = catalog[0].product;
    const pricingOptions = product.pricing_options as Array<Record<string, unknown>>;
    const account = { brand: { domain: 'buyerref.example' }, operator: 'buyerref.example' };

    const server = createTrainingAgentServer(DEFAULT_CTX);

    await simulateCallTool(server, 'create_media_buy', {
      buyer_ref: 'cd-ref-lookup',
      account,
      brand: { domain: 'buyerref.example' },
      start_time: '2025-01-01T00:00:00Z',
      end_time: '2025-12-31T00:00:00Z',
      packages: [{
        product_id: product.product_id,
        pricing_option_id: pricingOptions[0].pricing_option_id,
        budget: 10000,
        buyer_ref: 'pkg-ref',
      }],
    });

    const { result: buyResult } = await simulateCallTool(server, 'get_media_buys', { account });
    const buys = buyResult.media_buys as Array<Record<string, unknown>>;
    const mediaBuyId = buys[0].media_buy_id as string;
    const refPkgs = (buys[0] as Record<string, unknown>).packages as Array<Record<string, unknown>>;
    const refPackageId = refPkgs[0].package_id as string;

    await simulateCallTool(server, 'sync_creatives', {
      account,
      creatives: [{
        creative_id: 'ref_creative',
        name: 'Ref Creative',
        format_id: { agent_url: TEST_AGENT_URL, id: 'display_300x250' },
        assets: { headline: { asset_type: 'text', content: 'Ref' } },
      }],
      assignments: [{ media_buy_id: mediaBuyId, package_id: refPackageId, creative_id: 'ref_creative' }],
    });

    // Look up by buyer_refs
    const { result } = await simulateCallTool(server, 'get_creative_delivery', {
      account,
      media_buy_buyer_refs: ['cd-ref-lookup'],
    });

    expect(result.errors).toBeUndefined();
    const creatives = result.creatives as Array<Record<string, unknown>>;
    expect(creatives.length).toBe(1);
    expect(creatives[0].creative_id).toBe('ref_creative');
  });
});

// ── get_adcp_capabilities handler ─────────────────────────────────

describe('get_adcp_capabilities handler', () => {
  beforeEach(() => {
    invalidateCache();
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
  });

  it('returns protocol version and supported protocols', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_adcp_capabilities', {});

    expect(result.adcp).toEqual({ major_versions: [3] });
    expect(result.protocol_version).toBe('3.0');
    expect(result.supported_protocols).toEqual(['media_buy', 'governance']);
  });

  it('lists protocol tasks without get_adcp_capabilities itself', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_adcp_capabilities', {});

    const tasks = result.tasks as string[];
    expect(tasks).toContain('create_media_buy');
    expect(tasks).toContain('check_governance');
    expect(tasks).not.toContain('get_adcp_capabilities');
  });

  it('derives channels from the publisher catalog', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    const { result } = await simulateCallTool(server, 'get_adcp_capabilities', {});

    const mediaBuy = result.media_buy as Record<string, unknown>;
    const portfolio = mediaBuy.portfolio as Record<string, unknown>;
    const channels = portfolio.channels as string[];

    // Channels should match what publishers actually offer
    const publisherChannels = [...new Set(PUBLISHERS.flatMap(p => p.channels))].sort();
    expect(channels).toEqual(publisherChannels);
    expect(channels.length).toBeGreaterThan(4);
  });
});

// ── Governance: seller compliance ──────────────────────────────────

describe('check_governance seller compliance', () => {
  beforeEach(() => {
    invalidateCache();
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
  });

  const PLAN_BASE = {
    plan_id: 'plan-seller',
    brand: { name: 'Test' },
    objectives: 'test seller compliance',
    budget: { total: 100000, currency: 'USD', authority_level: 'agent_full' },
    flight: { start: '2027-01-01T00:00:00Z', end: '2027-12-31T23:59:59Z' },
  };

  it('approves caller in approved_sellers list', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    await simulateCallTool(server, 'sync_plans', {
      plans: [{ ...PLAN_BASE, approved_sellers: ['https://seller-a.example'] }],
    });

    const { result } = await simulateCallTool(server, 'check_governance', {
      plan_id: 'plan-seller',
      buyer_campaign_ref: 'camp-1',
      binding: 'proposed',
      caller: 'https://seller-a.example',
    });

    expect(result.status).toBe('approved');
  });

  it('denies caller not in approved_sellers list', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    await simulateCallTool(server, 'sync_plans', {
      plans: [{ ...PLAN_BASE, approved_sellers: ['https://seller-a.example'] }],
    });

    const { result } = await simulateCallTool(server, 'check_governance', {
      plan_id: 'plan-seller',
      buyer_campaign_ref: 'camp-1',
      binding: 'proposed',
      caller: 'https://unauthorized.example',
    });

    expect(result.status).toBe('denied');
    const findings = result.findings as Array<Record<string, unknown>>;
    expect(findings.some(f => f.category_id === 'seller_compliance')).toBe(true);
  });

  it('denies all callers when approved_sellers is empty array', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    await simulateCallTool(server, 'sync_plans', {
      plans: [{ ...PLAN_BASE, approved_sellers: [] }],
    });

    const { result } = await simulateCallTool(server, 'check_governance', {
      plan_id: 'plan-seller',
      buyer_campaign_ref: 'camp-1',
      binding: 'proposed',
      caller: 'https://any-seller.example',
    });

    expect(result.status).toBe('denied');
  });

  it('skips seller check when approved_sellers is omitted (undefined)', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    await simulateCallTool(server, 'sync_plans', {
      plans: [PLAN_BASE], // no approved_sellers field
    });

    const { result } = await simulateCallTool(server, 'check_governance', {
      plan_id: 'plan-seller',
      buyer_campaign_ref: 'camp-1',
      binding: 'proposed',
      caller: 'https://any-seller.example',
    });

    expect(result.status).toBe('approved');
    const categories = result.categories_evaluated as string[];
    expect(categories).not.toContain('seller_compliance');
  });

  it('skips seller check when approved_sellers is null (unrestricted)', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    await simulateCallTool(server, 'sync_plans', {
      plans: [{ ...PLAN_BASE, approved_sellers: null }],
    });

    const { result } = await simulateCallTool(server, 'check_governance', {
      plan_id: 'plan-seller',
      buyer_campaign_ref: 'camp-1',
      binding: 'proposed',
      caller: 'https://any-seller.example',
    });

    expect(result.status).toBe('approved');
    const categories = result.categories_evaluated as string[];
    expect(categories).not.toContain('seller_compliance');
  });
});

// ── Governance: delegation budget and market enforcement ────────────

describe('check_governance delegation enforcement', () => {
  beforeEach(() => {
    invalidateCache();
    clearSessions();
  });

  afterEach(() => {
    clearSessions();
  });

  const DELEGATED_PLAN = {
    plan_id: 'plan-deleg',
    brand: { name: 'Test' },
    objectives: 'test delegation limits',
    budget: { total: 100000, currency: 'USD', authority_level: 'agent_full' },
    flight: { start: '2027-01-01T00:00:00Z', end: '2027-12-31T23:59:59Z' },
    countries: ['US', 'GB', 'DE'],
    delegations: [{
      agent_url: 'https://delegated.example',
      authority: 'execute_only',
      budget_limit: { amount: 25000, currency: 'USD' },
      markets: ['US', 'GB'],
    }],
  };

  it('approves delegation within budget limit', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    await simulateCallTool(server, 'sync_plans', { plans: [DELEGATED_PLAN] });

    const { result } = await simulateCallTool(server, 'check_governance', {
      plan_id: 'plan-deleg',
      buyer_campaign_ref: 'camp-1',
      binding: 'proposed',
      caller: 'https://delegated.example',
      governance_context: {
        total_budget: { amount: 20000, currency: 'USD' },
        countries: ['US'],
        channels: [],
      },
    });

    expect(result.status).toBe('approved');
  });

  it('denies delegation exceeding budget limit', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    await simulateCallTool(server, 'sync_plans', { plans: [DELEGATED_PLAN] });

    const { result } = await simulateCallTool(server, 'check_governance', {
      plan_id: 'plan-deleg',
      buyer_campaign_ref: 'camp-1',
      binding: 'proposed',
      caller: 'https://delegated.example',
      governance_context: {
        total_budget: { amount: 30000, currency: 'USD' },
        countries: ['US'],
        channels: [],
      },
    });

    expect(result.status).toBe('denied');
    const findings = result.findings as Array<Record<string, unknown>>;
    expect(findings.some(f =>
      f.category_id === 'delegation_authority' &&
      (f.explanation as string).includes('budget limit'),
    )).toBe(true);
  });

  it('denies delegation targeting unauthorized markets', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    await simulateCallTool(server, 'sync_plans', { plans: [DELEGATED_PLAN] });

    const { result } = await simulateCallTool(server, 'check_governance', {
      plan_id: 'plan-deleg',
      buyer_campaign_ref: 'camp-1',
      binding: 'proposed',
      caller: 'https://delegated.example',
      governance_context: {
        total_budget: { amount: 10000, currency: 'USD' },
        countries: ['US', 'DE'],
        channels: [],
      },
    });

    expect(result.status).toBe('denied');
    const findings = result.findings as Array<Record<string, unknown>>;
    expect(findings.some(f =>
      f.category_id === 'delegation_authority' &&
      (f.explanation as string).includes('DE'),
    )).toBe(true);
  });

  it('approves delegation within allowed markets', async () => {
    const server = createTrainingAgentServer(DEFAULT_CTX);
    await simulateCallTool(server, 'sync_plans', { plans: [DELEGATED_PLAN] });

    const { result } = await simulateCallTool(server, 'check_governance', {
      plan_id: 'plan-deleg',
      buyer_campaign_ref: 'camp-1',
      binding: 'proposed',
      caller: 'https://delegated.example',
      governance_context: {
        total_budget: { amount: 10000, currency: 'USD' },
        countries: ['US', 'GB'],
        channels: [],
      },
    });

    expect(result.status).toBe('approved');
  });
});
