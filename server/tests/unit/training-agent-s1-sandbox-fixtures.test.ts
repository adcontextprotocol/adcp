/**
 * S1 sandbox demonstrations (adcp#9087): keyword overlay support on search and
 * retail-media offers, criteria-derived request_proposals plans with named
 * rejections, the seed_mb_broadcast_q4 provisional-C3 fixture, dimensional
 * delivery breakdowns, and the open availability_horizon calendar.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  createTrainingAgentServer,
  invalidateCache,
  clearTaskStore,
} from '../../src/training-agent/task-handlers.js';
import {
  clearSessions,
  getComplianceDeliverySimulation,
  getComplianceFixtureProductReporting,
  getComplianceMediaBuy,
  getComplianceMediaBuys,
} from '../../src/training-agent/state.js';
import { buildCatalog } from '../../src/training-agent/product-factory.js';
import { MUTATING_TOOLS, clearIdempotencyCache } from '../../src/training-agent/idempotency.js';

type Json = Record<string, any>;
type Server = ReturnType<typeof createTrainingAgentServer>;

const ACCOUNT = { brand: { domain: 'demo.example.com' }, operator: 'demo.example.com', sandbox: true };
const COMPACT_VERSIONS = ['3.2', '3.3-rc.3'] as const;
const KEYWORDS = [{ keyword: 'running shoes', match_type: 'broad' }, { keyword: 'trail shoes', match_type: 'exact' }];

async function callTool(server: Server, toolName: string, args: Json): Promise<Json> {
  const requestHandlers = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers;
  const handler = requestHandlers.get('tools/call');
  if (!handler) throw new Error('CallTool handler not found');
  const withKey = MUTATING_TOOLS.has(toolName) && args.idempotency_key === undefined
    ? { ...args, idempotency_key: `test-${crypto.randomUUID()}` }
    : args;
  const response = await handler({ method: 'tools/call', params: { name: toolName, arguments: withKey } }, {});
  const text = response.content?.[0]?.text;
  const parsed: Json = response.structuredContent ?? (text ? JSON.parse(text) : {});
  return parsed.adcp_error ?? parsed;
}

function purchases(response: Json): Json[] {
  return (response.proposals as Json[]).flatMap(proposal => proposal.commercial_terms.purchases as Json[]);
}

/** Finalize a draft and accept it, returning the accepted media buy id. */
async function finalizeAndAccept(server: Server, version: string, draft: Json): Promise<Json> {
  const refined = await callTool(server, 'refine_proposals', {
    adcp_version: version,
    refinements: [{ proposal_id: draft.proposal_id, action: 'finalize' }],
  });
  expect(refined.code, JSON.stringify(refined).slice(0, 500)).toBeUndefined();
  const finalized = refined.results[0].proposal as Json;
  return callTool(server, 'accept_proposal', {
    account: ACCOUNT, adcp_version: version,
    proposal_id: finalized.proposal_id,
    proposal_terms_digest: finalized.terms_digest,
    ...(finalized.insertion_order && {
      io_acceptance: {
        io_id: finalized.insertion_order.io_id,
        accepted_at: new Date().toISOString(),
        signatory: 'Sam Buyer',
      },
    }),
  });
}

beforeEach(async () => {
  await clearSessions();
  clearIdempotencyCache();
  invalidateCache();
  clearTaskStore();
});

describe('catalog product declarations', () => {
  const catalog = buildCatalog().map(entry => entry.product as unknown as Json);
  const byId = (id: string) => catalog.find(product => product.product_id === id)!;
  const MATCH_TYPES = { supported_match_types: ['broad', 'phrase', 'exact'] };

  it.each(['beacon_search_standard', 'shopgrid_standard'])('%s declares keyword overlay support and breakdown', id => {
    const product = byId(id);
    expect(product.overlay_support.keyword_targets).toEqual(MATCH_TYPES);
    expect(product.overlay_support.negative_keywords).toEqual(MATCH_TYPES);
    expect(product.reporting_capabilities.supports_keyword_breakdown).toBe(true);
  });

  it('declares keyword support only on search and retail_media products', () => {
    for (const product of catalog) {
      const sellsKeywords = (product.channels as string[]).some(c => c === 'search' || c === 'retail_media');
      expect(Boolean(product.overlay_support?.keyword_targets), product.product_id).toBe(sellsKeywords);
      expect(product.reporting_capabilities?.supports_keyword_breakdown === true, product.product_id).toBe(sellsKeywords);
    }
  });

  it('declares geo breakdown on every product and device_type only where devices exist', () => {
    const deviceChannels = new Set(['display', 'olv', 'social', 'influencer', 'search', 'retail_media', 'gaming', 'email',
      'streaming_audio', 'podcast', 'ctv', 'dooh', 'ooh']);
    // Collection offers (creator shows) carry audience_evidence and declare no dimensional breakdowns.
    const nonOffers = catalog.filter(product => product.audience_evidence === undefined);
    expect(nonOffers.length).toBeGreaterThan(0);
    for (const product of nonOffers) {
      expect(product.reporting_capabilities.supports_geo_breakdown, product.product_id)
        .toEqual({ country: true, region: true, metro: { nielsen_dma: true } });
      const hasDevices = (product.channels as string[]).some(channel => deviceChannels.has(channel));
      expect(product.reporting_capabilities.supports_device_type_breakdown === true, product.product_id).toBe(hasDevices);
    }
    const printOnly = nonOffers.filter(product => (product.channels as string[]).every(c => ['print', 'radio', 'linear_tv'].includes(c)));
    for (const product of printOnly) expect(product.reporting_capabilities.supports_device_type_breakdown).toBeUndefined();
  });
});

describe('seed_mb_broadcast_q4 compliance fixture', () => {
  it('is a completed linear-TV buy with C7 billing measurement terms', () => {
    const buy = getComplianceMediaBuy('seed_mb_broadcast_q4')!;
    expect(buy.status).toBe('completed');
    expect(buy.packages).toHaveLength(1);
    expect(buy.packages[0]!.productId).toBe('seed_product_linear_tv');
    expect(buy.packages[0]!.measurementTerms?.billing_measurement?.measurement_window).toBe('c7');
    expect(getComplianceMediaBuys().map(mb => mb.mediaBuyId)).toContain('seed_mb_broadcast_q4');
  });

  it('simulates a provisional C3 read', () => {
    expect(getComplianceDeliverySimulation('seed_mb_broadcast_q4')).toMatchObject({
      measurementWindow: 'c3', isFinal: false, plays: 48,
    });
    expect(getComplianceDeliverySimulation('seed_mb_display_q2')).toBeUndefined();
  });

  it('labels reporting facts for the seed products and returns a defensive copy', () => {
    const linear = getComplianceFixtureProductReporting('seed_product_linear_tv')!;
    expect(linear.channels).toEqual(['linear_tv']);
    expect((linear.reportingCapabilities.measurement_windows as Json[]).map(w => w.window_id)).toEqual(['live', 'c3', 'c7']);
    expect(getComplianceFixtureProductReporting('seed_product_display')!.reportingCapabilities.supports_device_type_breakdown).toBe(true);
    expect(getComplianceFixtureProductReporting('not_a_seed_product')).toBeUndefined();
    linear.channels.push('mutated');
    expect(getComplianceFixtureProductReporting('seed_product_linear_tv')!.channels).toEqual(['linear_tv']);
  });
});

describe('get_media_buys fixtures', () => {
  it('lists only seed_mb_display_q2 by default on an empty session', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const result = await callTool(server, 'get_media_buys', { account: ACCOUNT });
    expect((result.media_buys as Json[]).map(b => b.media_buy_id)).toEqual(['seed_mb_display_q2']);
  });

  it("lists the completed fixtures with status_filter: ['completed']", async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const result = await callTool(server, 'get_media_buys', { account: ACCOUNT, status_filter: ['completed'] });
    expect((result.media_buys as Json[]).map(b => b.media_buy_id).sort()).toEqual(['seed_mb_broadcast_q4', 'seed_mb_video_q1']);
  });
});

describe('get_media_buy_delivery fixtures and breakdowns', () => {
  const dimensions = { geo: { geo_level: 'country' }, device_type: {} };

  it.each(COMPACT_VERSIONS)('returns by_geo and by_device_type per package on seed_mb_display_q2 (%s)', async version => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const result = await callTool(server, 'get_media_buy_delivery', {
      account: ACCOUNT, adcp_version: version, media_buy_id: 'seed_mb_display_q2', reporting_dimensions: dimensions,
    });
    expect(result.errors).toBeUndefined();
    const packages = result.media_buy_deliveries[0].by_package as Json[];
    expect(packages).toHaveLength(2);
    for (const pkg of packages) {
      expect(pkg.by_geo.map((row: Json) => row.geo_code)).toEqual(['US']);
      expect(pkg.by_geo[0].impressions).toBe(pkg.impressions);
      expect(pkg.by_device_type.map((row: Json) => row.device_type).sort()).toEqual(['desktop', 'mobile', 'tablet']);
      const total = (pkg.by_device_type as Json[]).reduce((sum, row) => sum + row.impressions, 0);
      expect(total).toBe(pkg.impressions);
    }
  });

  it('omits the breakdowns when reporting_dimensions is absent', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const result = await callTool(server, 'get_media_buy_delivery', {
      account: ACCOUNT, adcp_version: '3.2', media_buy_id: 'seed_mb_display_q2',
    });
    for (const pkg of result.media_buy_deliveries[0].by_package as Json[]) {
      expect(pkg.by_geo).toBeUndefined();
      expect(pkg.by_device_type).toBeUndefined();
    }
  });

  it.each(['3.1', ...COMPACT_VERSIONS])('reports the provisional C3 window on seed_mb_broadcast_q4 (%s)', async version => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const result = await callTool(server, 'get_media_buy_delivery', {
      account: ACCOUNT, adcp_version: version, media_buy_id: 'seed_mb_broadcast_q4',
    });
    expect(result.errors).toBeUndefined();
    const delivery = result.media_buy_deliveries[0];
    expect(delivery.status).toBe('completed');
    expect(delivery.is_final).toBe(false);
    const pkg = delivery.by_package[0];
    expect(pkg).toMatchObject({
      measurement_window: 'c3', is_final: false, measurement_source: 'summit_measurement', plays: 48,
    });
  });

  it('declares geo but not device_type for the linear TV fixture', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const result = await callTool(server, 'get_media_buy_delivery', {
      account: ACCOUNT, adcp_version: '3.2', media_buy_id: 'seed_mb_broadcast_q4', reporting_dimensions: dimensions,
    });
    const pkg = result.media_buy_deliveries[0].by_package[0];
    expect(pkg.by_geo).toHaveLength(1);
    expect(pkg.by_device_type).toBeUndefined();
  });

  it.each(COMPACT_VERSIONS)('returns by_keyword rows for a created search buy (%s)', async version => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const product = buildCatalog().map(entry => entry.product as unknown as Json).find(p => p.product_id === 'beacon_search_standard')!;
    const created = await callTool(server, 'create_media_buy', {
      account: ACCOUNT,
      brand: ACCOUNT.brand,
      start_time: 'asap',
      end_time: '2027-12-31T00:00:00Z',
      packages: [{
        product_id: product.product_id,
        pricing_option_id: product.pricing_options[0].pricing_option_id,
        budget: 5000,
        bid_price: 2,
        targeting_overlay: {
          keyword_targets: [...KEYWORDS, KEYWORDS[0]],
          negative_keywords: [{ keyword: 'free', match_type: 'broad' }],
        },
      }],
    });
    expect(created.code, JSON.stringify(created)).toBeUndefined();
    const mediaBuyId = created.media_buy_id as string;
    const simulated = await callTool(server, 'comply_test_controller', {
      account: ACCOUNT, scenario: 'simulate_delivery',
      params: { media_buy_id: mediaBuyId, impressions: 20_000, clicks: 400, reported_spend: { amount: 800, currency: 'USD' } },
    });
    expect(simulated.success, JSON.stringify(simulated)).toBe(true);
    const result = await callTool(server, 'get_media_buy_delivery', {
      account: ACCOUNT, adcp_version: version, media_buy_id: mediaBuyId, reporting_dimensions: { keyword: {} },
    });
    expect(result.errors).toBeUndefined();
    const pkg = result.media_buy_deliveries[0].by_package[0];
    const rows = pkg.by_keyword as Json[];
    expect(rows.map(row => `${row.keyword}|${row.match_type}`).sort()).toEqual(['running shoes|broad', 'trail shoes|exact']);
    expect(rows.reduce((sum, row) => sum + row.impressions, 0)).toBe(pkg.impressions);
    expect(rows.reduce((sum, row) => sum + row.clicks, 0)).toBe(pkg.clicks);
  });
});

describe.each(COMPACT_VERSIONS)('request_proposals criteria-derived plans (%s)', version => {
  const request = (server: Server, criteria: Json) => callTool(server, 'request_proposals', {
    account: ACCOUNT, adcp_version: version, brief: 'Demonstrate the requested criteria', criteria,
  });

  it('plans configured products for criteria.targeting_overlay.geo_countries', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const response = await request(server, { targeting_overlay: { geo_countries: ['US'] } });
    expect(response.outcome, JSON.stringify(response).slice(0, 500)).toBe('proposed');
    const items = purchases(response);
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(3);
    for (const purchase of items) {
      expect(purchase.product_id).toMatch(/^configured_/);
      expect(purchase.targeting_overlay).toEqual({ geo_countries: ['US'] });
    }
    expect(response.proposals[0].proposal_id).toMatch(/^proposal_/);
  });

  it('plans the search offer for offer_filters.channels [search]', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const response = await request(server, { offer_filters: { channels: ['search'] } });
    expect(response.outcome).toBe('proposed');
    expect(purchases(response).map(p => p.product_id)).toEqual(['beacon_search_standard']);
  });

  it('plans only guaranteed offers for offer_filters.delivery_type', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const response = await request(server, { offer_filters: { delivery_type: 'guaranteed' } });
    expect(response.outcome).toBe('proposed');
    const guaranteed = new Set(buildCatalog()
      .map(entry => entry.product as unknown as Json)
      .filter(product => product.delivery_type === 'guaranteed')
      .map(product => product.product_id));
    for (const purchase of purchases(response)) expect(guaranteed.has(purchase.product_id)).toBe(true);
  });

  it('binds keyword targeting to the configured search and retail-media offers', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const response = await request(server, { targeting_overlay: { keyword_targets: KEYWORDS } });
    expect(response.outcome, JSON.stringify(response).slice(0, 500)).toBe('proposed');
    const items = purchases(response);
    expect(items.map(p => p.pricing_option_id).sort()).toEqual(['beacon_search_standard_pricing_0', 'shopgrid_standard_pricing_0']);
    for (const purchase of items) expect(purchase.targeting_overlay.keyword_targets).toEqual(KEYWORDS);
  });

  it('names criteria.targeting_overlay.keyword_targets when no offer supports it', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const response = await request(server, {
      offer_filters: { channels: ['print'] },
      targeting_overlay: { keyword_targets: KEYWORDS },
    });
    expect(response.outcome).toBe('rejected');
    expect(response.reason).toContain('criteria.targeting_overlay.keyword_targets');
    expect((response.suggestions as string[]).every(s => s.includes('criteria.targeting_overlay.keyword_targets'))).toBe(true);
  });

  it('names criteria.product_ids for an unknown product id', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const response = await request(server, { product_ids: ['no_such_product'] });
    expect(response.outcome).toBe('rejected');
    expect(response.reason).toContain('criteria.product_ids');
  });

  it('names criteria.offer_filters.channels for a channel no product sells', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const response = await request(server, { offer_filters: { channels: ['cinema'] } });
    expect(response.outcome).toBe('rejected');
    expect(response.reason).toContain('criteria.offer_filters.channels');
    expect((response.suggestions as string[])[0]).toContain('criteria.offer_filters.channels');
  });

  it('names criteria.required_overlay_support.<field> for an unsupported requirement', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const response = await request(server, {
      offer_filters: { channels: ['print'] },
      required_overlay_support: { keyword_targets: true },
    });
    expect(response.outcome).toBe('rejected');
    expect(response.reason).toContain('criteria.required_overlay_support.keyword_targets');
  });

  it('keeps fixture_match behavior in a controller-seeded session', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const seed = await callTool(server, 'comply_test_controller', {
      scenario: 'seed_product', account: ACCOUNT,
      params: { product_id: 's1_seeded_product', fixture: { delivery_type: 'non_guaranteed', channels: ['display'], pricing_options: [
        { pricing_option_id: 's1_po', pricing_model: 'cpm', currency: 'USD', fixed_price: 10 },
      ] } },
    });
    expect(seed.success, JSON.stringify(seed)).toBe(true);
    const response = await request(server, { product_ids: ['s1_seeded_product'] });
    expect(response.outcome).toBe('proposed');
    expect(response.proposals[0].proposal_id).not.toMatch(/^criteria_match_/);
    expect(purchases(response).map(p => p.product_id)).toEqual(['s1_seeded_product']);
  });
});

describe.each(COMPACT_VERSIONS)('keyword buy flow from request_proposals (%s)', version => {
  it('requests, finalizes, accepts, and reads back keyword targeting', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const requested = await callTool(server, 'request_proposals', {
      account: ACCOUNT, adcp_version: version, brief: 'Search campaign for running shoes',
      criteria: { targeting_overlay: { keyword_targets: KEYWORDS, geo_countries: ['US'] } },
    });
    expect(requested.outcome, JSON.stringify(requested).slice(0, 500)).toBe('proposed');
    const draft = requested.proposals[0] as Json;

    const refined = await callTool(server, 'refine_proposals', {
      adcp_version: version,
      refinements: [{ proposal_id: draft.proposal_id, action: 'finalize' }],
    });
    expect(refined.code, JSON.stringify(refined).slice(0, 500)).toBeUndefined();
    const finalized = refined.results[0].proposal as Json;
    expect(finalized.terms_digest).toEqual(expect.any(String));

    const accepted = await callTool(server, 'accept_proposal', {
      account: ACCOUNT, adcp_version: version,
      proposal_id: finalized.proposal_id,
      proposal_terms_digest: finalized.terms_digest,
      ...(finalized.insertion_order && {
        io_acceptance: {
          io_id: finalized.insertion_order.io_id,
          accepted_at: new Date().toISOString(),
          signatory: 'Sam Buyer',
        },
      }),
    });
    expect(accepted.code, JSON.stringify(accepted).slice(0, 500)).toBeUndefined();
    expect(accepted.media_buy_id).toEqual(expect.any(String));

    const readback = await callTool(server, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [accepted.media_buy_id] });
    const packages = readback.media_buys[0].packages as Json[];
    expect(packages.length).toBeGreaterThan(0);
    for (const pkg of packages) expect(pkg.targeting_overlay.keyword_targets).toEqual(KEYWORDS);
  });

  it('creates a media buy with keyword_targets and negative_keywords on a search product', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const product = buildCatalog().map(entry => entry.product as unknown as Json).find(p => p.product_id === 'beacon_search_standard')!;
    const created = await callTool(server, 'create_media_buy', {
      account: ACCOUNT, brand: ACCOUNT.brand, adcp_version: version,
      start_time: 'asap', end_time: '2027-12-31T00:00:00Z',
      packages: [{
        product_id: product.product_id,
        pricing_option_id: product.pricing_options[0].pricing_option_id,
        budget: 5000, bid_price: 2,
        targeting_overlay: { keyword_targets: KEYWORDS, negative_keywords: [{ keyword: 'free', match_type: 'phrase' }] },
      }],
    });
    expect(created.code, JSON.stringify(created)).toBeUndefined();
    expect(created.media_buy_id).toEqual(expect.any(String));
  });
});

describe.each(COMPACT_VERSIONS)('list_products availability_horizon in an ordinary session (%s)', version => {
  const HORIZON = { start_time: '2099-09-01T00:00:00Z', end_time: '2099-10-01T00:00:00Z' };

  it('answers each catalog product with one open availability row covering the horizon', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const response = await callTool(server, 'list_products', {
      account: ACCOUNT, adcp_version: version, criteria: { offer_filters: { availability_horizon: HORIZON } },
    });
    expect(response.code, JSON.stringify(response).slice(0, 400)).toBeUndefined();
    const products = response.products as Json[];
    expect(products.length).toBeGreaterThan(0);
    for (const product of products) {
      expect(product.forecast.forecast_range_unit, product.product_id).toBe('availability');
      expect(product.forecast.points).toHaveLength(1);
      expect(product.forecast.points[0]).toMatchObject({
        dimensions: [{ kind: 'time', start_time: HORIZON.start_time, end_time: HORIZON.end_time }],
        availability_status: 'available',
      });
    }
  });
});

describe('getComplianceDeliverySimulation periods', () => {
  const buy = () => getComplianceMediaBuy('seed_mb_broadcast_q4')!;

  it('reports the whole read with no period and for a period covering the flight', () => {
    const full = getComplianceDeliverySimulation('seed_mb_broadcast_q4')!;
    expect(full).toMatchObject({ impressions: 10_440_000, plays: 48, reportedSpend: { amount: 104_400, currency: 'USD' } });
    const covering = getComplianceDeliverySimulation('seed_mb_broadcast_q4', {
      start: new Date(Date.parse(buy().startTime) - 86_400_000),
      end: new Date(Date.parse(buy().endTime) + 86_400_000),
    })!;
    expect(covering.impressions).toBe(full.impressions);
    expect(covering.plays).toBe(48);
  });

  it('reports nothing for a period outside the flight and a proportional share inside it', () => {
    const outside = getComplianceDeliverySimulation('seed_mb_broadcast_q4', {
      start: new Date('2000-01-01T00:00:00Z'), end: new Date('2000-01-02T00:00:00Z'),
    })!;
    expect(outside).toMatchObject({ impressions: 0, plays: 0, reportedSpend: { amount: 0 } });
    const start = Date.parse(buy().startTime);
    const half = getComplianceDeliverySimulation('seed_mb_broadcast_q4', {
      start: new Date(start), end: new Date((start + Date.parse(buy().endTime)) / 2),
    })!;
    expect(half.reportedSpend!.amount).toBeCloseTo(104_400 / 2, 0);
    expect(half.impressions).toBe(Math.round(half.reportedSpend!.amount * 100));
    expect(half.plays).toBe(24);
  });
});

describe.each(COMPACT_VERSIONS)('dated reads of seed_mb_broadcast_q4 (%s)', version => {
  const read = (server: Server, period: Json) => callTool(server, 'get_media_buy_delivery', {
    account: ACCOUNT, adcp_version: version, media_buy_id: 'seed_mb_broadcast_q4', ...period,
  });
  const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  it('reports zero delivery for a period before the flight', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const result = await read(server, { start_date: '2000-01-01', end_date: '2000-01-02' });
    expect(result.errors).toBeUndefined();
    const delivery = result.media_buy_deliveries[0];
    expect(delivery.totals).toMatchObject({ impressions: 0, spend: 0, plays: 0 });
    expect(delivery.by_package[0]).toMatchObject({ impressions: 0, spend: 0, plays: 0 });
  });

  it('reports the full flight for a covering period', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const flight = getComplianceMediaBuy('seed_mb_broadcast_q4')!;
    const result = await read(server, {
      start_date: isoDay(Date.parse(flight.startTime) - 2 * 86_400_000),
      end_date: isoDay(Date.now() + 86_400_000),
    });
    expect(result.media_buy_deliveries[0].totals).toMatchObject({ impressions: 10_440_000, spend: 104_400, plays: 48 });
  });

  it('reports a proportional share for a period covering part of the flight', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const flight = getComplianceMediaBuy('seed_mb_broadcast_q4')!;
    const start = Date.parse(flight.startTime);
    const result = await read(server, {
      start_date: isoDay(start),
      end_date: isoDay(start + 3 * 86_400_000),
    });
    const totals = result.media_buy_deliveries[0].totals;
    expect(totals.spend).toBeGreaterThan(0);
    expect(totals.spend).toBeLessThan(104_400);
    expect(totals.impressions).toBe(Math.round(totals.spend * 100));
    expect(totals.plays).toBeGreaterThan(0);
    expect(totals.plays).toBeLessThan(48);
  });
});

describe.each(COMPACT_VERSIONS)('synthesized request_proposals plans stay executable (%s)', version => {
  const request = (server: Server, criteria: Json) => callTool(server, 'request_proposals', {
    account: ACCOUNT, adcp_version: version, brief: 'Demonstrate the requested criteria', criteria,
  });

  it('carries criteria.media_buy_frequency_cap into the plan and onto the accepted buy', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const cap = { max_impressions: 3, per: 'individuals', window: { interval: 1, unit: 'campaign' } };
    const response = await request(server, {
      offer_filters: { channels: ['search'] },
      media_buy_frequency_cap: cap,
      required_media_buy_support: { frequency_cap: true },
    });
    expect(response.outcome, JSON.stringify(response).slice(0, 500)).toBe('proposed');
    const draft = response.proposals[0] as Json;
    expect(draft.commercial_terms.frequency_cap).toEqual(cap);

    const accepted = await finalizeAndAccept(server, version, draft);
    expect(accepted.code, JSON.stringify(accepted).slice(0, 500)).toBeUndefined();
    const readback = await callTool(server, 'get_media_buys', { account: ACCOUNT, media_buy_ids: [accepted.media_buy_id] });
    expect(readback.media_buys[0].frequency_cap).toEqual(cap);
  });

  it('sizes the plan to each offer\'s min_spend_per_package and accepts it', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const response = await request(server, {
      offer_filters: { channels: ['linear_tv'] },
      targeting_overlay: { geo_countries: ['US'] },
    });
    expect(response.outcome, JSON.stringify(response).slice(0, 500)).toBe('proposed');
    const draft = response.proposals[0] as Json;
    const items = draft.commercial_terms.purchases as Json[];
    expect(items.length).toBeGreaterThan(0);
    for (const purchase of items) {
      expect(purchase.budget).toBeGreaterThanOrEqual(purchase.pricing.min_spend_per_package);
    }
    expect(items.map(p => p.pricing.min_spend_per_package)).toContain(25_000);
    expect(draft.commercial_terms.total_budget.amount).toBeGreaterThanOrEqual(25_000 * items.length);

    const accepted = await finalizeAndAccept(server, version, draft);
    expect(accepted.code, JSON.stringify(accepted).slice(0, 500)).toBeUndefined();
    expect(accepted.media_buy_id).toEqual(expect.any(String));
  });

  it('names criteria.offer_filters.budget_range when no offer fits the ceiling', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const response = await request(server, {
      offer_filters: { channels: ['linear_tv'], budget_range: { max: 5000, currency: 'USD' } },
      targeting_overlay: { geo_countries: ['US'] },
    });
    expect(response.outcome).toBe('rejected');
    expect(response.reason).toContain('criteria.offer_filters.budget_range');
  });

  it('plans a cost_per target only on offers priced in its currency', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const response = await request(server, {
      offer_filters: { channels: ['display'] },
      targeting_overlay: { geo_countries: ['US'] },
      outcome_target: {
        goal: { kind: 'metric', metric: 'clicks' },
        cost_per: { amount: 1, currency: 'EUR', strength: 'target' },
      },
    });
    expect(response.outcome, JSON.stringify(response).slice(0, 500)).toBe('proposed');
    const draft = response.proposals[0] as Json;
    const items = draft.commercial_terms.purchases as Json[];
    expect(items.length).toBeGreaterThan(0);
    for (const purchase of items) expect(purchase.pricing.currency).toBe('EUR');
    expect(draft.total_budget_guidance?.currency ?? draft.commercial_terms.total_budget.currency).toBe('EUR');
  });
});

describe.each(COMPACT_VERSIONS)('list_products open calendar with a sub-day horizon (%s)', version => {
  it('answers a 12-hour future horizon as available', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    const horizon = { start_time: '2099-09-01T00:00:00Z', end_time: '2099-09-01T12:00:00Z' };
    const response = await callTool(server, 'list_products', {
      account: ACCOUNT, adcp_version: version, criteria: { offer_filters: { availability_horizon: horizon } },
    });
    expect(response.code, JSON.stringify(response).slice(0, 400)).toBeUndefined();
    expect((response.products as Json[]).length).toBeGreaterThan(0);
    for (const product of response.products as Json[]) {
      expect(product.forecast.points, product.product_id).toHaveLength(1);
      expect(product.forecast.points[0].availability_status, product.product_id).toBe('available');
    }
  });
});
