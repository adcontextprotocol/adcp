import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import { createTrainingAgentServer, invalidateCache, clearTaskStore } from '../../src/training-agent/task-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { clearIdempotencyCache, MUTATING_TOOLS } from '../../src/training-agent/idempotency.js';

const storyboard = YAML.parse(readFileSync(new URL(
  '../../../static/compliance/source/protocols/media-buy/scenarios/product_coverage_filters.yaml',
  import.meta.url,
), 'utf8'));
const account = storyboard.phases[0].steps[0].sample_request.account;
type Server = ReturnType<typeof createTrainingAgentServer>;
async function call(server: Server, name: string, args: Record<string, unknown>) {
  const handlers = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers;
  const handler = handlers.get('tools/call');
  if (!handler) throw new Error('Missing MCP tools/call handler');
  const response = await handler({ method: 'tools/call', params: { name, arguments: {
    ...(MUTATING_TOOLS.has(name) && { idempotency_key: randomUUID() }), ...args,
  } } }, {});
  const payload = response.structuredContent ?? JSON.parse(response.content[0].text);
  return payload.adcp_error ?? payload.errors?.[0] ?? payload;
}
async function seed(server: Server) {
  for (const { product_id, ...fixture } of storyboard.fixtures.products) {
    expect(await call(server, 'comply_test_controller', {
      account, scenario: 'seed_product', params: { product_id, fixture },
    })).toMatchObject({ success: true });
  }
  for (const { product_id, pricing_option_id, ...fixture } of storyboard.fixtures.pricing_options) {
    expect(await call(server, 'comply_test_controller', {
      account, scenario: 'seed_pricing_option', params: { product_id, pricing_option_id, fixture },
    })).toMatchObject({ success: true });
  }
}
function atPath(value: unknown, path: string): unknown {
  return path.replace(/\[(\d+)\]/g, '.$1').split('.').reduce<unknown>((current, key) =>
    current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined, value);
}

describe('product coverage across retained and compact discovery', () => {
  beforeEach(() => { clearSessions(); invalidateCache(); clearTaskStore(); clearIdempotencyCache(); });

  it.each(['3.0', '3.1', '3.2-rc.7'])('preserves the graded legacy query at %s', async version => {
    const server = createTrainingAgentServer({ mode: 'open' });
    await seed(server);
    const step = storyboard.phases[0].steps[0];
    const response = await call(server, step.task, { ...step.sample_request, adcp_version: version });
    expect(response.code, JSON.stringify(response)).toBeUndefined();
    for (const validation of step.validations) {
      if (validation.check === 'field_value') expect(atPath(response, validation.path)).toEqual(validation.value);
      if (validation.check === 'field_absent') expect(atPath(response, validation.path)).toBeUndefined();
    }
  });

  it('runs the compact storyboard through real SDK server dispatch', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    await seed(server);
    const step = storyboard.phases[1].steps[0];
    const response = await call(server, step.task, { ...step.sample_request, adcp_version: '3.2-rc.7' });
    expect(response.code, JSON.stringify(response)).toBeUndefined();
    for (const validation of step.validations) {
      if (validation.check === 'field_value') expect(atPath(response, validation.path)).toEqual(validation.value);
      if (validation.check === 'field_absent') expect(atPath(response, validation.path)).toBeUndefined();
    }
  });

  it('applies Canadian coverage and US delivery independently', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    await seed(server);
    const response = await call(server, 'get_products', {
      ...storyboard.phases[0].steps[0].sample_request,
      adcp_version: '3.2-rc.7',
      targeting_overlay: { geo_countries: ['US'] },
    });
    expect(response.code, JSON.stringify(response)).toBeUndefined();
    expect(response.products).toHaveLength(1);
    expect(response.products[0].is_custom).toBe(true);
    expect(response.products[0].pricing_options[0].floor_price).toBe(10);
  });

  it('distinguishes no matches from unsupported coverage evaluation', async () => {
    const server = createTrainingAgentServer({ mode: 'open' });
    await seed(server);
    const base = { account, buying_mode: 'wholesale', adcp_version: '3.2-rc.7' };
    const empty = await call(server, 'get_products', {
      ...base, filters: { pricing_currencies: ['USD'], countries: ['GB'] },
    });
    expect(empty.code, JSON.stringify(empty)).toBeUndefined();
    expect(empty.products).toEqual([]);
    const unsupported = await call(server, 'get_products', {
      ...base, filters: { pricing_currencies: ['USD'], regions: ['US-NY'] },
    });
    expect(unsupported).toMatchObject({ code: 'UNSUPPORTED_FEATURE', field: '/filters/regions' });
  });
});

const METRO_SYSTEMS = ['nielsen_dma', 'uk_itl1', 'uk_itl2', 'eurostat_nuts2', 'custom'];
const openAccount = { brand: { domain: 'acmeoutdoor.example' }, operator: 'pinnacle-agency.example', sandbox: true };
const briefBase = {
  account: openAccount,
  buying_mode: 'brief',
  brief: 'Sponsored creator videos on YouTube and TikTok',
};
const coverageOf = (product: any) => product.ext?.training?.coverage;
const ids = (response: any): string[] => (response.products ?? []).map((p: any) => p.product_id).sort();

async function wholesale(server: Server, filters?: Record<string, unknown>) {
  return call(server, 'get_products', { account: openAccount, buying_mode: 'wholesale', ...(filters && { filters }) });
}

describe('market filters on the unseeded training catalogue', () => {
  beforeEach(() => { clearSessions(); invalidateCache(); clearTaskStore(); clearIdempotencyCache(); });

  describe('A. creator brief discovery (issue #9177 repro table)', () => {
    async function brief(filters: Record<string, unknown>) {
      const server = createTrainingAgentServer({ mode: 'open' });
      return call(server, 'get_products', { ...briefBase, filters });
    }

    it('returns a non-empty list of creator products for filters: {}', async () => {
      const response = await brief({});
      expect(response.code, JSON.stringify(response)).toBeUndefined();
      expect(ids(response).length).toBeGreaterThan(0);
      for (const product of response.products) expect(product.product_id).toMatch(/^creatorloop_creator_/);
    });

    it('countries [US] succeeds with the same products as {}', async () => {
      const base = await brief({});
      const us = await brief({ countries: ['US'] });
      expect(us.code, JSON.stringify(us)).toBeUndefined();
      expect(ids(us)).toEqual(ids(base));
    });

    it('countries [GB] succeeds and returns only creators whose coverage includes GB', async () => {
      // Brief results are relevance-ranked and capped, so the filtered list can
      // admit products the unfiltered list ranked out; compare on coverage facts.
      const base = await brief({});
      const gb = await brief({ countries: ['GB'] });
      expect(gb.code, JSON.stringify(gb)).toBeUndefined();
      expect(ids(gb).length).toBeGreaterThan(0);
      for (const product of gb.products) expect(coverageOf(product).countries, product.product_id).toContain('GB');
      const baseWithoutGb = base.products
        .filter((p: any) => !coverageOf(p).countries.includes('GB'))
        .map((p: any) => p.product_id);
      expect(baseWithoutGb.length).toBeGreaterThan(0);
      for (const id of baseWithoutGb) expect(ids(gb)).not.toContain(id);
      const baseWithGb = base.products
        .filter((p: any) => coverageOf(p).countries.includes('GB'))
        .map((p: any) => p.product_id);
      for (const id of baseWithGb) expect(ids(gb)).toContain(id);
    });

    it('countries [US, CA] succeeds with the same products as {}', async () => {
      const base = await brief({});
      const both = await brief({ countries: ['US', 'CA'] });
      expect(both.code, JSON.stringify(both)).toBeUndefined();
      expect(ids(both)).toEqual(ids(base));
    });

    it('regions [US-NY] is refused as UNSUPPORTED_FEATURE at /filters/regions', async () => {
      const response = await brief({ regions: ['US-NY'] });
      expect(response).toMatchObject({ code: 'UNSUPPORTED_FEATURE', field: '/filters/regions' });
    });

    it('countries_exclude [CA] succeeds with the same products as {}', async () => {
      const base = await brief({});
      const excluded = await brief({ countries_exclude: ['CA'] });
      expect(excluded.code, JSON.stringify(excluded)).toBeUndefined();
      expect(ids(excluded)).toEqual(ids(base));
    });
  });

  describe('B. compact discovery surfaces', () => {
    const compact = { account: openAccount, adcp_version: '3.2-rc.7' };

    it('list_products criteria.offer_filters.countries [US] returns products without an error', async () => {
      const server = createTrainingAgentServer({ mode: 'open' });
      const response = await call(server, 'list_products', { ...compact, criteria: { offer_filters: { countries: ['US'] } } });
      expect(response.code, JSON.stringify(response)).toBeUndefined();
      expect(response.products.length).toBeGreaterThan(0);
      for (const product of response.products) expect(coverageOf(product)?.countries).toContain('US');
    });

    it('list_products criteria.offer_filters.regions is refused as UNSUPPORTED_FEATURE at /criteria/offer_filters/regions', async () => {
      const server = createTrainingAgentServer({ mode: 'open' });
      const response = await call(server, 'list_products', { ...compact, criteria: { offer_filters: { regions: ['US-NY'] } } });
      expect(response).toMatchObject({ code: 'UNSUPPORTED_FEATURE', field: '/criteria/offer_filters/regions' });
    });

    it('request_proposals offer_filters.countries [US] proposes; regions is refused at /criteria/offer_filters/regions', async () => {
      const server = createTrainingAgentServer({ mode: 'open' });
      const request = {
        ...compact,
        brief: 'Sponsored creator videos on YouTube and TikTok',
      };
      const covered = await call(server, 'request_proposals', {
        ...request, criteria: { offer_filters: { countries: ['US'] } },
      });
      expect(covered.code, JSON.stringify(covered)).toBeUndefined();
      expect(covered.outcome).toBe('proposed');
      expect(covered.proposals.length).toBeGreaterThan(0);
      const unsupported = await call(server, 'request_proposals', {
        ...request, criteria: { offer_filters: { regions: ['US-NY'] } },
      });
      expect(unsupported).toMatchObject({ code: 'UNSUPPORTED_FEATURE', field: '/criteria/offer_filters/regions' });
    });
  });

  describe('C. products without coverage facts are left out, not refused', () => {
    const seededAccount = storyboard.phases[0].steps[0].sample_request.account;
    async function seedProduct(server: Server, product_id: string, fixture: Record<string, unknown>) {
      const base = storyboard.fixtures.products[0];
      const { product_id: _ignored, ext: _ext, ...template } = base;
      expect(await call(server, 'comply_test_controller', {
        account: seededAccount, scenario: 'seed_product',
        params: { product_id, fixture: { ...template, ...fixture } },
      })).toMatchObject({ success: true });
      const pricing = storyboard.fixtures.pricing_options[0];
      const { product_id: _p, pricing_option_id, ...pricingFixture } = pricing;
      expect(await call(server, 'comply_test_controller', {
        account: seededAccount, scenario: 'seed_pricing_option',
        params: { product_id, pricing_option_id, fixture: pricingFixture },
      })).toMatchObject({ success: true });
    }
    const query = (server: Server, filters: Record<string, unknown>) => call(server, 'get_products', {
      account: seededAccount, buying_mode: 'wholesale', adcp_version: '3.2-rc.7',
      filters: { pricing_currencies: ['USD'], ...filters },
    });

    it('countries [US] returns only the covered seeded product', async () => {
      const server = createTrainingAgentServer({ mode: 'open' });
      await seedProduct(server, 'cov_us_only', { ext: { training: { coverage: { countries: ['US'] } } } });
      await seedProduct(server, 'cov_none', {});
      const response = await query(server, { countries: ['US'] });
      expect(response.code, JSON.stringify(response)).toBeUndefined();
      expect(ids(response)).toEqual(['cov_us_only']);
    });

    it('metros returns only the product that declares metros when another lacks them', async () => {
      const server = createTrainingAgentServer({ mode: 'open' });
      const metro = { system: 'nielsen_dma', code: '501' };
      await seedProduct(server, 'cov_metro', { ext: { training: { coverage: { countries: ['US'], metros: [metro] } } } });
      await seedProduct(server, 'cov_national', { ext: { training: { coverage: { countries: ['US'] } } } });
      const response = await query(server, { metros: [metro] });
      expect(response.code, JSON.stringify(response)).toBeUndefined();
      expect(ids(response)).toEqual(['cov_metro']);
    });
  });

  describe('D. metros on the built-in catalogue', () => {
    it('returns only products whose coverage lists DMA 501 and no error', async () => {
      const server = createTrainingAgentServer({ mode: 'open' });
      const all = await wholesale(server);
      const metro = { system: 'nielsen_dma', code: '501' };
      const response = await wholesale(server, { metros: [metro] });
      expect(response.code, JSON.stringify(response)).toBeUndefined();
      const expected = all.products
        .filter((p: any) => coverageOf(p)?.metros?.some((m: any) => m.system === 'nielsen_dma' && m.code === '501'))
        .map((p: any) => p.product_id).sort();
      expect(expected).toContain('streetlevel_premium');
      expect(ids(response)).toEqual(expected);
      expect(ids(response).length).toBeLessThan(ids(all).length);
      for (const product of response.products) expect(coverageOf(product).metros).toBeDefined();
    });
  });

  describe('E. catalogue invariants', () => {
    // get_products drops overlay_support from its default projection; list_products keeps it.
    async function listAll(server: Server) {
      const response = await call(server, 'list_products', { account: openAccount, adcp_version: '3.2-rc.7', max_results: 100 });
      expect(response.code, JSON.stringify(response)).toBeUndefined();
      return response.products as any[];
    }

    it('every built-in product declares well-formed coverage', async () => {
      const server = createTrainingAgentServer({ mode: 'open' });
      const response = await wholesale(server);
      expect(response.code, JSON.stringify(response)).toBeUndefined();
      expect(response.products.length).toBeGreaterThan(0);
      for (const product of response.products) {
        const coverage = coverageOf(product);
        expect(coverage?.countries, product.product_id).toBeInstanceOf(Array);
        expect(coverage.countries.length, product.product_id).toBeGreaterThan(0);
        for (const country of coverage.countries) expect(country).toMatch(/^[A-Z]{2}$/);
        for (const metro of coverage.metros ?? []) {
          expect(METRO_SYSTEMS, product.product_id).toContain(metro.system);
          expect(typeof metro.code, product.product_id).toBe('string');
        }
      }
    });

    it('creator products cover countries without offering geo_countries targeting', async () => {
      const server = createTrainingAgentServer({ mode: 'open' });
      const creators = (await listAll(server)).filter(p => p.product_id.startsWith('creatorloop_creator_'));
      expect(creators.length).toBeGreaterThan(0);
      for (const product of creators) {
        expect(coverageOf(product).countries.length, product.product_id).toBeGreaterThan(0);
        expect(product.overlay_support, product.product_id).toBeDefined();
        expect(product.overlay_support, product.product_id).not.toHaveProperty('geo_countries');
      }
    });
  });
});
