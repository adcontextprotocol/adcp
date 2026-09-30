import { describe, it, expect, beforeEach } from 'vitest';
import {
  createTrainingAgentServer,
  invalidateCache,
  clearTaskStore,
} from '../../src/training-agent/task-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import { validateSourceSchema } from '../../src/training-agent/source-schema.js';
import { TRAINING_AGENT_CURRENT_ADCP_VERSION, type TrainingContext } from '../../src/training-agent/types.js';

// list_products returns the closed core/canonical-product.json shape. The
// default catalog is built as legacy Products, so the unprojected listing must
// not carry legacy-only keys (audience_activation, installments, is_custom)
// that get_products still returns. Collection composition, targeting
// resolution, and reporting_capabilities.reporting_delivery_offering_ids are
// canonical and must survive the projection wherever the catalog has them.

const DEFAULT_CTX: TrainingContext = { mode: 'open' };
const ACCOUNT = { brand: { domain: 'acmeoutdoor.example' }, operator: 'pinnacle-agency.example', sandbox: true };

type Product = Record<string, unknown> & { product_id: string };

async function callTool(
  server: ReturnType<typeof createTrainingAgentServer>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestHandlers = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers;
  const handler = requestHandlers.get('tools/call')!;
  const response = await handler(
    {
      method: 'tools/call',
      params: { name: toolName, arguments: { adcp_version: TRAINING_AGENT_CURRENT_ADCP_VERSION, ...args } },
    },
    {},
  );
  const text = response.content?.[0]?.text;
  return response.structuredContent
    ? (response.structuredContent as Record<string, unknown>)
    : (text ? JSON.parse(text) : {});
}

async function listAllProducts(
  server: ReturnType<typeof createTrainingAgentServer>,
  args: Record<string, unknown> = {},
): Promise<Product[]> {
  const products: Product[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await callTool(server, 'list_products', {
      account: ACCOUNT,
      max_results: 10,
      ...args,
      ...(cursor && { cursor }),
    });
    expect(result.outcome, JSON.stringify(result).slice(0, 500)).toBe('listed');
    products.push(...(result.products as Product[]));
    cursor = typeof result.next_cursor === 'string' ? result.next_cursor : undefined;
    if (!cursor) return products;
  }
  throw new Error('list_products did not finish paginating');
}

function canonicalViolations(products: Product[]): string[] {
  return products.flatMap(product => {
    const validation = validateSourceSchema('core/canonical-product.json', product);
    return validation.valid
      ? []
      : validation.errors.map(error => `${product.product_id}${error.instancePath} ${error.message} ${JSON.stringify(error.params)}`);
  });
}

function byId(products: Product[]): Map<string, Product> {
  return new Map(products.map(product => [product.product_id, product]));
}

describe('list_products canonical product projection', () => {
  let server: ReturnType<typeof createTrainingAgentServer>;

  beforeEach(async () => {
    await clearSessions();
    clearIdempotencyCache();
    invalidateCache();
    clearTaskStore();
    server = createTrainingAgentServer(DEFAULT_CTX);
  });

  it('returns every default-catalog product in the closed canonical shape without a fields projection', async () => {
    const products = await listAllProducts(server);
    expect(products.length).toBeGreaterThan(1);
    expect(canonicalViolations(products)).toEqual([]);
  });

  it('carries canonical collection, reporting-offering, and targeting fields wherever the catalog has them', async () => {
    const compact = byId(await listAllProducts(server));
    const legacyResult = await callTool(server, 'get_products', { account: ACCOUNT, buying_mode: 'wholesale' });
    const legacy = legacyResult.products as Product[];
    expect(legacy.length).toBeGreaterThan(1);

    let withCollections = 0;
    let withCollectionTargeting = 0;
    for (const product of legacy) {
      const listed = compact.get(product.product_id);
      expect(listed, product.product_id).toBeDefined();
      expect(listed).not.toHaveProperty('is_custom');
      expect(listed).not.toHaveProperty('audience_activation');
      expect(listed).not.toHaveProperty('installments');
      if (Array.isArray(product.collections)) {
        withCollections += 1;
        expect(listed!.collections, product.product_id).toEqual(product.collections);
      }
      if (product.collection_targeting_allowed !== undefined) {
        withCollectionTargeting += 1;
        expect(listed!.collection_targeting_allowed, product.product_id).toBe(product.collection_targeting_allowed);
      }
      const offeringIds = (product.reporting_capabilities as Record<string, unknown> | undefined)
        ?.reporting_delivery_offering_ids;
      if (offeringIds !== undefined) {
        expect(
          (listed!.reporting_capabilities as Record<string, unknown>).reporting_delivery_offering_ids,
          product.product_id,
        ).toEqual(offeringIds);
      }
    }
    expect(withCollections).toBeGreaterThan(0);
    expect(withCollectionTargeting).toBeGreaterThan(0);
  });

  it('keeps collection_targeting_allowed and offering ids under a fields projection that needs them', async () => {
    const legacyResult = await callTool(server, 'get_products', { account: ACCOUNT, buying_mode: 'wholesale' });
    const collectionProduct = (legacyResult.products as Product[]).find(product => (
      product.collection_targeting_allowed === true && Array.isArray(product.collections)
    ));
    expect(collectionProduct).toBeDefined();
    const [listed] = await listAllProducts(server, {
      criteria: { product_ids: [collectionProduct!.product_id] },
      fields: ['collections', 'collection_targeting_allowed', 'reporting_capabilities'],
    });
    expect(listed).toMatchObject({
      product_id: collectionProduct!.product_id,
      collections: collectionProduct!.collections,
      collection_targeting_allowed: true,
      reporting_capabilities: {
        reporting_delivery_offering_ids: (collectionProduct!.reporting_capabilities as Record<string, unknown>)
          .reporting_delivery_offering_ids,
      },
    });
    expect(canonicalViolations([listed!])).toEqual([]);
  });

  it('never emits is_custom on list_products, including configured products from a targeting_overlay', async () => {
    const products = await listAllProducts(server, {
      criteria: { targeting_overlay: { geo_countries: ['US'] } },
    });
    expect(products.length).toBeGreaterThan(0);
    expect(products.some(product => product.product_id.startsWith('configured_'))).toBe(true);
    for (const product of products) {
      expect(product, product.product_id).not.toHaveProperty('is_custom');
      if (product.product_id.startsWith('configured_')) {
        expect(typeof product.expires_at, product.product_id).toBe('string');
      }
    }
    expect(canonicalViolations(products)).toEqual([]);

    const projected = await listAllProducts(server, {
      criteria: { targeting_overlay: { geo_countries: ['US'] } },
      fields: ['description'],
    });
    expect(projected.every(product => !('is_custom' in product))).toBe(true);
    expect(canonicalViolations(projected)).toEqual([]);
  });

  it('returns targeting_resolution with expires_at for a configured product that modifies the overlay', async () => {
    const productId = 'canonical_targeting_resolution_product';
    const seeded = await callTool(server, 'comply_test_controller', {
      account: ACCOUNT,
      brand: ACCOUNT.brand,
      scenario: 'seed_product',
      params: {
        product_id: productId,
        fixture: {
          channels: ['display'],
          delivery_type: 'non_guaranteed',
          overlay_support: {
            browser: { families: ['chrome', 'safari'] },
            demographics: { age: true },
          },
          demographic_targeting: {
            age: {
              execution_modes: ['enumerated_intervals'],
              unknown_handling: 'always_excluded',
              intervals: [
                { interval_id: 'age_18_24', age: { min: 18, max: 24, include_unknown: false } },
                { interval_id: 'age_25_34', age: { min: 25, max: 34, include_unknown: false } },
                { interval_id: 'age_35_44', age: { min: 35, max: 44, include_unknown: false } },
              ],
            },
          },
          browser_inventory: {
            forecastable_families: ['chrome'],
            unavailable_families: ['safari'],
          },
        },
      },
    });
    expect(seeded.success, JSON.stringify(seeded)).toBe(true);
    const pricing = await callTool(server, 'comply_test_controller', {
      account: ACCOUNT,
      brand: ACCOUNT.brand,
      scenario: 'seed_pricing_option',
      params: {
        product_id: productId,
        pricing_option_id: 'canonical_targeting_resolution_cpm',
        fixture: { pricing_model: 'cpm', currency: 'USD', fixed_price: 10 },
      },
    });
    expect(pricing.success, JSON.stringify(pricing)).toBe(true);

    const overlay = {
      demographics: { age: { min: 21, max: 35, include_unknown: false } },
      browser: ['chrome', 'safari'],
    };
    for (const fields of [undefined, ['description']]) {
      const products = await listAllProducts(server, {
        criteria: { product_ids: [productId], targeting_overlay: overlay },
        ...(fields && { fields }),
      });
      expect(products).toHaveLength(1);
      const [configured] = products;
      expect(configured).toMatchObject({
        product_id: expect.stringMatching(/^configured_/),
        expires_at: expect.any(String),
        targeting_resolution: {
          modifications: expect.arrayContaining([
            expect.objectContaining({ path: '/browser' }),
          ]),
        },
      });
      expect(configured).not.toHaveProperty('is_custom');
      expect(canonicalViolations(products)).toEqual([]);
    }
  });

  it('leaves the legacy get_products representation carrying its legacy-only keys', async () => {
    const result = await callTool(server, 'get_products', { account: ACCOUNT, buying_mode: 'wholesale' });
    const products = result.products as Product[];
    expect(products.length).toBeGreaterThan(1);
    expect(products.every(product => product.audience_activation !== undefined)).toBe(true);
    expect(products.some(product => Array.isArray(product.collections))).toBe(true);
    expect(products.some(product => Array.isArray(product.installments))).toBe(true);
    expect(products.some(product => product.collection_targeting_allowed === true)).toBe(true);
    expect(products.every(product => Array.isArray(
      (product.reporting_capabilities as Record<string, unknown> | undefined)?.reporting_delivery_offering_ids,
    ))).toBe(true);
  });
});
