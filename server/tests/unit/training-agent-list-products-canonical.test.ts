import { describe, it, expect, beforeEach, vi } from 'vitest';

// Installments are a 3.3 canonical-product field, so the canonical shape this
// suite grades is served to a 3.3 caller. The trusted local candidate wire
// contract is the only way the training agent serves 3.3.
vi.hoisted(() => {
  process.env.ADCP_STORYBOARD_CANDIDATE_VERSION_MODE = '1';
  process.env.ADCP_TRAINING_CANDIDATE_VERSION = '3.3-beta.1';
});

import {
  createTrainingAgentServer,
  invalidateCache,
  clearTaskStore,
  compactLifecycleProduct,
} from '../../src/training-agent/task-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import { validateSourceSchema } from '../../src/training-agent/source-schema.js';
import { getCanonicalToolValidator } from '@adcp/sdk/schemas';
import { TRAINING_AGENT_CURRENT_ADCP_VERSION, type TrainingContext } from '../../src/training-agent/types.js';

// list_products returns the closed core/canonical-product.json shape. The
// default catalog is built as legacy Products, so the unprojected listing must
// not carry legacy-only keys (audience_activation, is_custom) that get_products
// still returns. Collection composition, installments, targeting resolution,
// and reporting_capabilities.reporting_delivery_offering_ids are canonical and
// must survive the projection wherever the catalog has them. Installments
// project onto core/canonical-installment.json, which drops the legacy
// deprecated collection_id shorthand and requires collection_ref.

const THREE_THREE_VERSION = '3.3-beta.1';
const DEFAULT_CTX: TrainingContext = { mode: 'open' };
const ACCOUNT = { brand: { domain: 'acmeoutdoor.example' }, operator: 'pinnacle-agency.example', sandbox: true };

type Product = Record<string, unknown> & { product_id: string };

async function callTool(
  server: ReturnType<typeof createTrainingAgentServer>,
  toolName: string,
  args: Record<string, unknown>,
  adcpVersion: string = THREE_THREE_VERSION,
): Promise<Record<string, unknown>> {
  const requestHandlers = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers;
  const handler = requestHandlers.get('tools/call')!;
  const response = await handler(
    {
      method: 'tools/call',
      params: { name: toolName, arguments: { adcp_version: adcpVersion, ...args } },
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
  adcpVersion: string = THREE_THREE_VERSION,
): Promise<Product[]> {
  const products: Product[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page += 1) {
    const result = await callTool(server, 'list_products', {
      account: ACCOUNT,
      max_results: 10,
      ...args,
      ...(cursor && { cursor }),
    }, adcpVersion);
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
    let withInstallments = 0;
    for (const product of legacy) {
      const listed = compact.get(product.product_id);
      expect(listed, product.product_id).toBeDefined();
      expect(listed).not.toHaveProperty('is_custom');
      expect(listed).not.toHaveProperty('audience_activation');
      if (Array.isArray(product.collections)) {
        withCollections += 1;
        expect(listed!.collections, product.product_id).toEqual(product.collections);
      }
      if (Array.isArray(product.installments)) {
        withInstallments += 1;
        const legacyInstallments = product.installments as Record<string, unknown>[];
        const listedInstallments = listed!.installments as Record<string, unknown>[] | undefined;
        expect(listedInstallments, product.product_id).toBeDefined();
        expect(listedInstallments!.map(entry => entry.installment_id), product.product_id)
          .toEqual(legacyInstallments.map(entry => entry.installment_id));
        for (const entry of listedInstallments!) {
          // Canonical identity is the tuple, and the deprecated
          // publisher-domain-free shorthand never reaches the closed shape.
          expect(entry.collection_ref, product.product_id).toBeDefined();
          expect(entry, product.product_id).not.toHaveProperty('collection_id');
        }
        // A canonical installment names its collection, so the product that
        // carries one always carries the collections that scope its IDs.
        expect(listed!.collections, product.product_id).toBeDefined();
      } else {
        expect(listed, product.product_id).not.toHaveProperty('installments');
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
    expect(withInstallments).toBeGreaterThan(0);
  });

  // The catalog always builds installments with collection_ref, so these
  // cases are unreachable through the seeded products. They are the ones that
  // matter for a seller migrating a legacy catalog: an installments array the
  // closed canonical shape cannot carry must not quietly become a
  // run-of-collection claim, which is what an omitted array means.
  it('projects a legacy installment set all-or-nothing, never into a false run-of-collection claim', async () => {
    const legacy = (await callTool(server, 'get_products', { account: ACCOUNT, buying_mode: 'wholesale' }).then(
      result => (result.products as Product[]).find(product => Array.isArray(product.installments)),
    ))!;
    expect(legacy).toBeDefined();
    const installments = legacy.installments as Record<string, unknown>[];

    const project = (product: Record<string, unknown>): Record<string, unknown> | undefined => {
      const projected = compactLifecycleProduct(product, new Set(['installments', 'collections']));
      return projected.installments as Record<string, unknown>[] | undefined;
    };

    // Baseline: the seeded product projects every slot.
    expect(project(legacy)).toHaveLength(installments.length);

    // One unprojectable slot drops the whole array rather than shortening it.
    const orphan = { ...structuredClone(installments[0]), installment_id: 'orphan' } as Record<string, unknown>;
    delete orphan.collection_ref;
    delete orphan.collection_id;
    expect(project({ ...legacy, installments: [...installments, orphan] })).toBeUndefined();

    // The deprecated shorthand resolves when the product names one namespace.
    const shorthandOnly = structuredClone(installments[0]) as Record<string, unknown>;
    const collectionRef = shorthandOnly.collection_ref as { publisher_domain: string; collection_id: string };
    delete shorthandOnly.collection_ref;
    shorthandOnly.collection_id = collectionRef.collection_id;
    const resolved = project({ ...legacy, installments: [shorthandOnly] });
    expect(resolved![0].collection_ref).toEqual(collectionRef);
    expect(resolved![0]).not.toHaveProperty('collection_id');

    // Without collections there is nothing to scope the IDs against, and the
    // canonical product schema requires them alongside.
    expect(project({ ...legacy, collections: undefined })).toBeUndefined();

    // Legacy allows empty arrays where the canonical shape requires one entry.
    const empties = { ...structuredClone(installments[0]), topics: [], guest_talent: [] } as Record<string, unknown>;
    const projectedEmpties = project({ ...legacy, installments: [empties] })![0];
    expect(projectedEmpties).not.toHaveProperty('topics');
    expect(projectedEmpties).not.toHaveProperty('guest_talent');
    expect(validateSourceSchema('core/canonical-installment.json', projectedEmpties).valid).toBe(true);

    // A non-array value must never survive the verbatim field copy.
    expect(project({ ...legacy, installments: { installment_id: 'nope' } })).toBeUndefined();
  });

  it('pulls collections into a fields projection that asks only for installments', async () => {
    const legacyResult = await callTool(server, 'get_products', { account: ACCOUNT, buying_mode: 'wholesale' });
    const slotProduct = (legacyResult.products as Product[]).find(product => (
      Array.isArray(product.installments) && Array.isArray(product.collections)
    ));
    expect(slotProduct).toBeDefined();
    const [listed] = await listAllProducts(server, {
      criteria: { product_ids: [slotProduct!.product_id] },
      fields: ['installments'],
    });
    expect(listed).toBeDefined();
    const installments = listed.installments as Record<string, unknown>[];
    expect(installments.length).toBeGreaterThan(0);
    // The canonical installment names its collection, and the Product schema
    // requires the collections that scope those IDs, so the narrow projection
    // cannot return a schema-invalid product.
    expect(listed.collections).toBeDefined();
    expect(canonicalViolations([listed])).toEqual([]);
    const scoped = new Set((listed.collections as { collection_ids: string[] }[])
      .flatMap(selector => selector.collection_ids));
    for (const entry of installments) {
      const ref = entry.collection_ref as { publisher_domain: string; collection_id: string };
      expect(scoped.has(ref.collection_id), JSON.stringify(ref)).toBe(true);
    }
  });

  // #8487: the closed 3.2 core/canonical-product.json has no installments, so
  // a 3.2 caller gets the products without them, and a narrow projection that
  // asks for them gets neither installments nor the collections they pull in.
  it('withholds the 3.3 installments from a 3.2 caller', async () => {
    const validateThreeTwo = getCanonicalToolValidator('list_products', 'sync', { adcpVersion: '3.2' });
    expect(validateThreeTwo).toBeDefined();
    const threeTwo: Product[] = [];
    let cursor: string | undefined;
    do {
      const page = await callTool(server, 'list_products', {
        account: ACCOUNT, max_results: 10, ...(cursor && { cursor }),
      }, TRAINING_AGENT_CURRENT_ADCP_VERSION);
      // Root envelope keys are out of scope here: the adcp_version echo is
      // required on every response (versioning.mdx) although the closed 3.2
      // list_products root omits it (3.3 adds it), and this in-process
      // dispatcher stamps envelope status. SDK clients relax the response
      // root for both.
      const { adcp_version: echoed, status: _status, ...body } = page;
      expect(echoed).toBe(TRAINING_AGENT_CURRENT_ADCP_VERSION);
      expect(validateThreeTwo!(body), JSON.stringify(validateThreeTwo!.errors)).toBe(true);
      threeTwo.push(...(page.products as Product[]));
      cursor = typeof page.next_cursor === 'string' ? page.next_cursor : undefined;
    } while (cursor);
    const threeThree = byId(await listAllProducts(server));
    expect(threeTwo.length).toBe(threeThree.size);
    expect(threeTwo.filter(product => product.installments !== undefined)).toEqual([]);
    expect([...threeThree.values()].some(product => Array.isArray(product.installments))).toBe(true);
    for (const product of threeTwo) {
      const { installments: _installments, ...rest } = threeThree.get(product.product_id)!;
      expect(product).toEqual(rest);
    }

    const slotProduct = [...threeThree.values()].find(product => Array.isArray(product.installments));
    const [narrow] = await listAllProducts(server, {
      criteria: { product_ids: [slotProduct!.product_id] },
      fields: ['installments'],
    }, TRAINING_AGENT_CURRENT_ADCP_VERSION);
    expect(narrow).toEqual({ product_id: slotProduct!.product_id, name: slotProduct!.name });
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
