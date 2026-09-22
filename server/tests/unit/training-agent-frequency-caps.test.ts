import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import {
  createTrainingAgentServer,
  executeTrainingAgentTool,
  invalidateCache,
  clearTaskStore,
} from '../../src/training-agent/task-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { MUTATING_TOOLS, clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import { TRAINING_AGENT_CURRENT_ADCP_VERSION, type TrainingContext } from '../../src/training-agent/types.js';
import {
  TRAINING_AGGREGATE_FREQUENCY_CAPPING,
  TRAINING_PACKAGE_FREQUENCY_CAPPING,
  mediaBuyFrequencyCapError,
  mediaBuySupportRequirementMatches,
  packageFrequencyCapChangeError,
  packageFrequencyCapError,
  packageFrequencyCapRequirementMatches,
} from '../../src/training-agent/frequency-caps.js';

const DEFAULT_CTX: TrainingContext = { mode: 'open' };
const ACCOUNT = { brand: { domain: 'frequency-caps.example' }, operator: 'pinnacle-agency.example', sandbox: true };
const BRAND = { domain: 'frequency-caps.example' };
const FLIGHT = { start_time: '2099-09-01T00:00:00Z', end_time: '2099-09-30T23:59:59Z' };
const CAMPAIGN_WINDOW = { interval: 1, unit: 'campaign' };

const SHARED_CONSTRAINTS = {
  mutable_fields: ['max_impressions'],
  supported_control_modes: ['max_impressions'],
  supported_per_units: ['individuals'],
  max_impressions_constraints: { minimum: 1, maximum: 10 },
  window_constraints: [{ unit: 'campaign', allowed_intervals: [1] }],
};

const PRODUCTS: Record<string, Record<string, unknown>> = {
  fc_legacy_shared: {
    overlay_support: { frequency_cap: true },
    media_buy_support: { frequency_cap: true, frequency_cap_constraints: SHARED_CONSTRAINTS },
  },
  fc_companion_shared: {
    media_buy_support: { frequency_cap: true, frequency_cap_constraints: SHARED_CONSTRAINTS },
  },
  fc_household_shared: {
    media_buy_support: {
      frequency_cap: true,
      frequency_cap_constraints: { ...SHARED_CONSTRAINTS, mutable_fields: [], supported_per_units: ['households'] },
    },
  },
  fc_unshared: {},
  fc_create_only: {
    overlay_support: {
      frequency_cap_support: {
        mutable_fields: [],
        supported_control_modes: ['max_impressions'],
        supported_per_units: ['individuals'],
        max_impressions_constraints: { allowed_values: [2, 3] },
        window_constraints: [{ unit: 'campaign', allowed_intervals: [1] }],
      },
    },
  },
  fc_mutable: {
    overlay_support: {
      frequency_cap_support: {
        mutable_fields: ['max_impressions'],
        supported_control_modes: ['max_impressions'],
        supported_per_units: ['individuals'],
        max_impressions_constraints: { allowed_values: [2, 5] },
      },
    },
    allowed_actions: [{ action: 'update_frequency_caps', modes: ['self_serve'] }],
  },
};

function withRequestDefaults(toolName: string, args: Record<string, unknown>): Record<string, unknown> {
  const versioned = args.adcp_version === undefined && toolName !== 'comply_test_controller'
    ? { adcp_version: TRAINING_AGENT_CURRENT_ADCP_VERSION, ...args }
    : args;
  if (!MUTATING_TOOLS.has(toolName) || versioned.idempotency_key !== undefined) return versioned;
  return { ...versioned, idempotency_key: `test-${crypto.randomUUID()}` };
}

type ToolResult = { result: Record<string, unknown>; error?: Record<string, unknown> };

async function callTool(
  server: ReturnType<typeof createTrainingAgentServer>,
  toolName: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const requestHandlers = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers;
  const handler = requestHandlers.get('tools/call');
  if (!handler) throw new Error('CallTool handler not found');
  const response = await handler(
    { method: 'tools/call', params: { name: toolName, arguments: withRequestDefaults(toolName, args) } },
    {},
  );
  const text = response.content?.[0]?.text;
  const parsed: Record<string, unknown> = response.structuredContent
    ? (response.structuredContent as Record<string, unknown>)
    : (text ? JSON.parse(text) : {});
  const errorInBody = Array.isArray(parsed.errors) && parsed.errors.length > 0
    ? parsed.errors[0] as Record<string, unknown>
    : undefined;
  const error = (parsed.adcp_error as Record<string, unknown> | undefined) ?? errorInBody;
  return { result: parsed, ...(error && { error }) };
}

async function seedCatalog(server: ReturnType<typeof createTrainingAgentServer>): Promise<void> {
  for (const [productId, fixture] of Object.entries(PRODUCTS)) {
    const seeded = await callTool(server, 'comply_test_controller', {
      scenario: 'seed_product',
      account: ACCOUNT,
      brand: BRAND,
      params: {
        product_id: productId,
        fixture: {
          delivery_type: 'non_guaranteed',
          channels: ['display'],
          format_options: [{ format_option_id: `${productId}_300x250`, format_kind: 'image', params: { width: 300, height: 250 } }],
          ...fixture,
        },
      },
    });
    expect(seeded.result.success, JSON.stringify(seeded.result)).toBe(true);
    const priced = await callTool(server, 'comply_test_controller', {
      scenario: 'seed_pricing_option',
      account: ACCOUNT,
      brand: BRAND,
      params: {
        product_id: productId,
        pricing_option_id: `${productId}_cpm`,
        fixture: { pricing_model: 'cpm', currency: 'USD', floor_price: 2 },
      },
    });
    expect(priced.result.success, JSON.stringify(priced.result)).toBe(true);
  }
}

function pkg(productId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { product_id: productId, pricing_option_id: `${productId}_cpm`, budget: 5000, bid_price: 3, ...extra };
}

function cap(maxImpressions: number, per = 'individuals', window: Record<string, unknown> = CAMPAIGN_WINDOW) {
  return { max_impressions: maxImpressions, per, window };
}

async function createBuy(
  server: ReturnType<typeof createTrainingAgentServer>,
  body: Record<string, unknown>,
): Promise<ToolResult> {
  return callTool(server, 'create_media_buy', { account: ACCOUNT, brand: BRAND, ...FLIGHT, ...body });
}

async function readBuy(
  server: ReturnType<typeof createTrainingAgentServer>,
  mediaBuyId: string,
): Promise<Record<string, unknown>> {
  const { result } = await callTool(server, 'get_media_buys', { account: ACCOUNT, brand: BRAND, media_buy_ids: [mediaBuyId] });
  const buys = result.media_buys as Array<Record<string, unknown>>;
  expect(buys, JSON.stringify(result)).toHaveLength(1);
  return buys[0]!;
}

function actions(buy: Record<string, unknown>): Array<Record<string, unknown>> {
  return buy.available_actions as Array<Record<string, unknown>>;
}

describe('training agent frequency caps', () => {
  let server: ReturnType<typeof createTrainingAgentServer>;

  beforeEach(async () => {
    await clearSessions();
    clearIdempotencyCache();
    invalidateCache();
    clearTaskStore();
    server = createTrainingAgentServer(DEFAULT_CTX);
  });

  describe('constraint helpers', () => {
    it('inherits omitted structured fields from the seller-wide declaration and never broadens it', () => {
      const product = PRODUCTS.fc_mutable;
      // Omitted window_constraints inherit every seller-wide window unit.
      expect(packageFrequencyCapRequirementMatches(product, {
        mutable_fields: ['max_impressions'],
        supported_window_units: ['campaign', 'days'],
      })).toBe(true);
      // A unit absent from the seller-wide declaration never matches.
      expect(packageFrequencyCapRequirementMatches(product, { supported_window_units: ['weeks'] })).toBe(false);
      // mutable_fields: [] never matches a non-empty requirement; legacy true matches everything.
      expect(packageFrequencyCapRequirementMatches(PRODUCTS.fc_create_only, { mutable_fields: ['max_impressions'] })).toBe(false);
      expect(packageFrequencyCapRequirementMatches(PRODUCTS.fc_legacy_shared, { mutable_fields: ['per', 'window'] })).toBe(true);
      expect(packageFrequencyCapRequirementMatches(PRODUCTS.fc_unshared, {})).toBe(false);
    });

    it('validates package caps against presets, ranges, units, and mutable fields', () => {
      expect(packageFrequencyCapError(PRODUCTS.fc_mutable, cap(5), 'p')).toBeUndefined();
      expect(packageFrequencyCapError(PRODUCTS.fc_mutable, cap(4), 'p')).toMatchObject({
        code: 'UNSUPPORTED_FEATURE',
        field: 'p.max_impressions',
      });
      expect(packageFrequencyCapError(PRODUCTS.fc_mutable, cap(5, 'households'), 'p')).toMatchObject({ field: 'p.per' });
      expect(packageFrequencyCapError(PRODUCTS.fc_create_only, cap(3, 'individuals', { interval: 7, unit: 'days' }), 'p'))
        .toMatchObject({ field: 'p.window.unit' });
      expect(packageFrequencyCapError(PRODUCTS.fc_mutable, { suppress: { interval: 30, unit: 'minutes' } }, 'p'))
        .toMatchObject({ code: 'UNSUPPORTED_FEATURE', field: 'p' });
      // Legacy and undeclared products are held to the seller-wide contract only.
      expect(packageFrequencyCapError(PRODUCTS.fc_legacy_shared, cap(40, 'devices', { interval: 3, unit: 'hours' }), 'p')).toBeUndefined();
      expect(packageFrequencyCapError(PRODUCTS.fc_unshared, cap(2, 'custom'), 'p')).toMatchObject({ field: 'p.per' });
      expect(packageFrequencyCapChangeError(PRODUCTS.fc_mutable, cap(5), cap(2), 'p')).toBeUndefined();
      expect(packageFrequencyCapChangeError(PRODUCTS.fc_mutable, cap(5), cap(5, 'households'), 'p'))
        .toMatchObject({ code: 'UNSUPPORTED_FEATURE', field: 'p.per' });
      expect(packageFrequencyCapChangeError(PRODUCTS.fc_legacy_shared, cap(5), cap(5, 'households'), 'p')).toBeUndefined();
    });

    it('validates root caps against the seller-wide domain and every product', () => {
      const products = (ids: string[]) => ids.map(id => ({ productId: id, product: PRODUCTS[id], field: `packages.${id}` }));
      expect(mediaBuyFrequencyCapError(cap(3), products(['fc_legacy_shared', 'fc_companion_shared']), 'frequency_cap')).toBeUndefined();
      expect(mediaBuyFrequencyCapError(cap(3), products(['fc_legacy_shared', 'fc_unshared']), 'frequency_cap'))
        .toMatchObject({ code: 'UNSUPPORTED_FEATURE', field: 'packages.fc_unshared' });
      expect(mediaBuyFrequencyCapError(cap(3), products(['fc_legacy_shared', 'fc_household_shared']), 'frequency_cap'))
        .toMatchObject({ code: 'UNSUPPORTED_FEATURE', field: 'frequency_cap.per' });
      expect(mediaBuyFrequencyCapError(cap(11), products(['fc_legacy_shared']), 'frequency_cap'))
        .toMatchObject({ field: 'frequency_cap.max_impressions' });
      expect(mediaBuyFrequencyCapError(
        cap(TRAINING_AGGREGATE_FREQUENCY_CAPPING.max_impressions_constraints.maximum + 1),
        products(['fc_legacy_shared']),
        'frequency_cap',
      )).toMatchObject({ field: 'frequency_cap.max_impressions' });
      expect(mediaBuyFrequencyCapError({ suppress: { interval: 1, unit: 'hours' } }, products(['fc_legacy_shared']), 'frequency_cap'))
        .toMatchObject({ code: 'UNSUPPORTED_FEATURE' });
      expect(mediaBuySupportRequirementMatches(PRODUCTS.fc_household_shared, {
        frequency_cap: true,
        frequency_cap_constraints: { mutable_fields: ['max_impressions'] },
      })).toBe(false);
      expect(mediaBuySupportRequirementMatches(PRODUCTS.fc_legacy_shared, {
        frequency_cap: true,
        frequency_cap_constraints: { mutable_fields: ['max_impressions'], supported_per_units: ['individuals'] },
      })).toBe(true);
    });
  });

  it('advertises package and aggregate frequency capping', async () => {
    const { result } = await callTool(server, 'get_adcp_capabilities', {});
    const mediaBuy = result.media_buy as Record<string, unknown>;
    expect(mediaBuy.frequency_capping).toEqual(TRAINING_PACKAGE_FREQUENCY_CAPPING);
    expect(mediaBuy.aggregate_frequency_capping).toEqual(TRAINING_AGGREGATE_FREQUENCY_CAPPING);
  });

  it('matches structured package-cap requirements with seller-wide inheritance', async () => {
    await seedCatalog(server);
    const { result } = await callTool(server, 'get_products', {
      account: ACCOUNT,
      brand: BRAND,
      buying_mode: 'brief',
      brief: 'Display inventory with a package cap that can be updated.',
      required_overlay_support: {
        frequency_cap_support: {
          mutable_fields: ['max_impressions'],
          supported_per_units: ['individuals'],
          supported_window_units: ['campaign'],
        },
      },
    });
    const ids = (result.products as Array<Record<string, unknown>>).map(product => product.product_id);
    expect(ids).toContain('fc_mutable');
    expect(ids).toContain('fc_legacy_shared');
    expect(ids).not.toContain('fc_create_only');
    expect(ids).not.toContain('fc_unshared');
    const mutable = (result.products as Array<Record<string, unknown>>).find(product => product.product_id === 'fc_mutable')!;
    const support = (mutable.overlay_support as Record<string, Record<string, unknown>>).frequency_cap_support;
    expect(support.mutable_fields).toEqual(['max_impressions']);
    expect(support.window_constraints).toBeUndefined();
  });

  it('gates discovery on shared-counter participation and the exact aggregate value', async () => {
    await seedCatalog(server);
    const { result } = await callTool(server, 'get_products', {
      account: ACCOUNT,
      brand: BRAND,
      buying_mode: 'brief',
      brief: 'Display inventory for a two-package buy with a shared cap.',
      media_buy_frequency_cap: cap(3),
      required_media_buy_support: { frequency_cap: true },
    });
    const products = result.products as Array<Record<string, unknown>>;
    expect(products.map(product => product.product_id).sort()).toEqual(['fc_companion_shared', 'fc_legacy_shared']);
    expect(products.every(product => (product.media_buy_support as Record<string, unknown>).frequency_cap === true)).toBe(true);

    const constrained = await callTool(server, 'get_products', {
      account: ACCOUNT,
      brand: BRAND,
      buying_mode: 'brief',
      brief: 'Display inventory for a household cap.',
      required_media_buy_support: {
        frequency_cap: true,
        frequency_cap_constraints: { supported_per_units: ['households'] },
      },
      fields: ['product_id', 'name'],
    });
    const householdProducts = constrained.result.products as Array<Record<string, unknown>>;
    expect(householdProducts.map(product => product.product_id)).toEqual(['fc_household_shared']);
    // media_buy_support is included whenever it was requested, regardless of fields.
    expect(householdProducts[0]!.media_buy_support).toMatchObject({ frequency_cap: true });
  });

  it('echoes the bound aggregate cap on legacy proposals', async () => {
    const { result } = await callTool(server, 'get_products', {
      account: { brand: { domain: 'uncapped-brand.example' }, operator: 'pinnacle-agency.example' },
      brand: { domain: 'uncapped-brand.example' },
      buying_mode: 'brief',
      brief: 'Display inventory for a two-package buy with a shared cap.',
      media_buy_frequency_cap: cap(3),
    });
    const proposals = result.proposals as Array<Record<string, unknown>>;
    expect(proposals.length).toBeGreaterThan(0);
    expect(proposals.every(proposal => JSON.stringify(proposal.frequency_cap) === JSON.stringify(cap(3)))).toBe(true);
  });

  it('rejects caps outside capability before any mutation and never clamps', async () => {
    await seedCatalog(server);
    const nonParticipating = await createBuy(server, {
      frequency_cap: cap(3),
      packages: [pkg('fc_legacy_shared'), pkg('fc_unshared')],
    });
    expect(nonParticipating.error).toMatchObject({ code: 'UNSUPPORTED_FEATURE', field: 'packages[1].product_id' });

    const perMismatch = await createBuy(server, {
      frequency_cap: cap(3),
      packages: [pkg('fc_legacy_shared'), pkg('fc_household_shared')],
    });
    expect(perMismatch.error).toMatchObject({ code: 'UNSUPPORTED_FEATURE', field: 'frequency_cap.per' });

    const outOfRange = await createBuy(server, {
      packages: [pkg('fc_mutable', { targeting_overlay: { frequency_cap: cap(4) } })],
    });
    expect(outOfRange.error).toMatchObject({
      code: 'UNSUPPORTED_FEATURE',
      field: 'packages[0].targeting_overlay.frequency_cap.max_impressions',
    });

    const listed = await callTool(server, 'get_media_buys', { account: ACCOUNT, brand: BRAND, status_filter: ['active', 'pending_creatives'] });
    const listedBuys = listed.result.media_buys as Array<{ packages: Array<{ product_id: string }> }>;
    expect(listedBuys.some(buy => buy.packages.some(entry => entry.product_id.startsWith('fc_')))).toBe(false);
  });

  it('keeps package caps independent, names eligible packages, and enforces update boundaries', async () => {
    await seedCatalog(server);
    const created = await createBuy(server, {
      packages: [
        pkg('fc_create_only', { targeting_overlay: { frequency_cap: cap(3) } }),
        pkg('fc_mutable', { targeting_overlay: { frequency_cap: cap(5) } }),
      ],
    });
    expect(created.error, JSON.stringify(created.result)).toBeUndefined();
    const mediaBuyId = created.result.media_buy_id as string;
    const [createOnlyPkg, mutablePkg] = created.result.packages as Array<Record<string, unknown>>;
    let revision = created.result.revision as number;

    const buy = await readBuy(server, mediaBuyId);
    expect(buy.frequency_cap).toBeUndefined();
    expect(actions(buy)).toContainEqual(expect.objectContaining({
      action: 'update_frequency_caps',
      applicable_package_ids: [mutablePkg!.package_id],
    }));
    expect(actions(buy).some(action => action.action === 'update_media_buy_frequency_cap')).toBe(false);

    const control = (packageId: unknown, frequencyCap: Record<string, unknown>) => callTool(server, 'control_media_buy', {
      account: ACCOUNT,
      media_buy_id: mediaBuyId,
      revision,
      packages: [{ package_id: packageId, targeting_overlay: { frequency_cap: frequencyCap } }],
    });

    const immutable = await control(createOnlyPkg!.package_id, cap(2));
    expect(immutable.error).toMatchObject({
      code: 'ACTION_NOT_ALLOWED',
      details: expect.objectContaining({ attempted_action: 'update_frequency_caps' }),
    });
    // Authorization precedes capability: an out-of-range count on the
    // create-only package still reports the missing action, not the shape.
    const immutableOutOfRange = await control(createOnlyPkg!.package_id, cap(4));
    expect(immutableOutOfRange.error).toMatchObject({
      code: 'ACTION_NOT_ALLOWED',
      details: expect.objectContaining({ attempted_action: 'update_frequency_caps' }),
    });
    const mixed = await callTool(server, 'control_media_buy', {
      account: ACCOUNT,
      media_buy_id: mediaBuyId,
      revision,
      packages: [
        { package_id: mutablePkg!.package_id, targeting_overlay: { frequency_cap: cap(4) } },
        { package_id: createOnlyPkg!.package_id, targeting_overlay: { frequency_cap: cap(2) } },
      ],
    });
    expect(mixed.error).toMatchObject({ code: 'ACTION_NOT_ALLOWED' });
    const outOfRange = await control(mutablePkg!.package_id, cap(4));
    expect(outOfRange.error).toMatchObject({ code: 'UNSUPPORTED_FEATURE' });
    const fixedField = await control(mutablePkg!.package_id, cap(5, 'individuals', { interval: 7, unit: 'days' }));
    expect(fixedField.error).toMatchObject({
      code: 'UNSUPPORTED_FEATURE',
      field: 'packages[0].targeting_overlay.frequency_cap.window',
    });

    const updated = await control(mutablePkg!.package_id, cap(2));
    expect(updated.error, JSON.stringify(updated.result)).toBeUndefined();
    expect(updated.result.affected_package_ids).toEqual([mutablePkg!.package_id]);
    revision = updated.result.revision as number;

    const readBack = await readBuy(server, mediaBuyId);
    const caps = (readBack.packages as Array<Record<string, unknown>>)
      .map(entry => ((entry.targeting_overlay as Record<string, unknown>).frequency_cap as Record<string, unknown>).max_impressions);
    expect(caps).toEqual([3, 2]);
    expect(readBack.revision).toBe(revision);
  });

  it('replaces and clears the root cap, guards new packages, and applies the resulting-state rule', async () => {
    await seedCatalog(server);
    const created = await createBuy(server, {
      frequency_cap: cap(3),
      packages: [
        pkg('fc_legacy_shared', { targeting_overlay: { frequency_cap: cap(5) } }),
        pkg('fc_companion_shared'),
      ],
    });
    expect(created.error, JSON.stringify(created.result)).toBeUndefined();
    expect(created.result.frequency_cap).toEqual(cap(3));
    const mediaBuyId = created.result.media_buy_id as string;
    let revision = created.result.revision as number;

    const initial = await readBuy(server, mediaBuyId);
    expect(initial.frequency_cap).toEqual(cap(3));
    expect(actions(initial)).toContainEqual(expect.objectContaining({ action: 'update_media_buy_frequency_cap' }));
    expect(actions(initial)).toContainEqual(expect.objectContaining({ action: 'update_frequency_caps' }));
    expect(actions(initial).find(action => action.action === 'update_frequency_caps')!.applicable_package_ids).toBeUndefined();

    const replaced = await callTool(server, 'control_media_buy', {
      account: ACCOUNT, media_buy_id: mediaBuyId, revision, frequency_cap: cap(2),
    });
    expect(replaced.error, JSON.stringify(replaced.result)).toBeUndefined();
    expect(replaced.result.affected_package_ids).toHaveLength(2);
    revision = replaced.result.revision as number;
    const afterReplace = await readBuy(server, mediaBuyId);
    expect(afterReplace.frequency_cap).toEqual(cap(2));
    expect(((afterReplace.packages as Array<Record<string, unknown>>)[0]!.targeting_overlay as Record<string, unknown>).frequency_cap)
      .toEqual(cap(5));

    const rejectedAdd = await callTool(server, 'update_media_buy', {
      account: ACCOUNT, media_buy_id: mediaBuyId, revision, new_packages: [pkg('fc_unshared')],
    });
    expect(rejectedAdd.error).toMatchObject({ code: 'UNSUPPORTED_FEATURE', field: 'new_packages[0].product_id' });
    expect((await readBuy(server, mediaBuyId)).packages).toHaveLength(2);

    const tightened = await callTool(server, 'update_media_buy', {
      account: ACCOUNT, media_buy_id: mediaBuyId, revision, frequency_cap: cap(11),
    });
    expect(tightened.error).toMatchObject({ code: 'UNSUPPORTED_FEATURE', field: 'frequency_cap.max_impressions' });
    const fixedRootField = await callTool(server, 'control_media_buy', {
      account: ACCOUNT, media_buy_id: mediaBuyId, revision, frequency_cap: cap(2, 'individuals', { interval: 7, unit: 'days' }),
    });
    expect(fixedRootField.error).toMatchObject({ code: 'UNSUPPORTED_FEATURE', field: 'frequency_cap.window' });

    const cleared = await callTool(server, 'update_media_buy', {
      account: ACCOUNT, media_buy_id: mediaBuyId, revision, frequency_cap: null, new_packages: [pkg('fc_unshared')],
    });
    expect(cleared.error, JSON.stringify(cleared.result)).toBeUndefined();
    expect(cleared.result.frequency_cap).toBeUndefined();
    revision = cleared.result.revision as number;
    const uncapped = await readBuy(server, mediaBuyId);
    expect(uncapped.frequency_cap).toBeUndefined();
    expect(uncapped.packages).toHaveLength(3);
    expect(actions(uncapped).some(action => action.action === 'update_media_buy_frequency_cap')).toBe(false);

    const recap = await callTool(server, 'control_media_buy', {
      account: ACCOUNT, media_buy_id: mediaBuyId, revision, frequency_cap: cap(3),
    });
    expect(recap.error).toMatchObject({
      code: 'ACTION_NOT_ALLOWED',
      details: expect.objectContaining({ attempted_action: 'update_media_buy_frequency_cap' }),
    });
  });

  it('reports observed frequency at or below the tightest enforced cap', async () => {
    await seedCatalog(server);
    const created = await createBuy(server, {
      start_time: 'asap',
      packages: [pkg('fc_legacy_shared', { targeting_overlay: { frequency_cap: cap(3, 'individuals', { interval: 1, unit: 'days' }) } })],
    });
    expect(created.error, JSON.stringify(created.result)).toBeUndefined();
    const mediaBuyId = created.result.media_buy_id as string;
    const simulated = await callTool(server, 'comply_test_controller', {
      account: ACCOUNT,
      brand: BRAND,
      scenario: 'simulate_delivery',
      params: { media_buy_id: mediaBuyId, impressions: 8550, reported_spend: { amount: 1500, currency: 'USD' } },
    });
    expect(simulated.result.success, JSON.stringify(simulated.result)).toBe(true);
    const { result } = await callTool(server, 'get_media_buy_delivery', { account: ACCOUNT, brand: BRAND, media_buy_ids: [mediaBuyId] });
    const totals = (result.media_buy_deliveries as Array<Record<string, unknown>>)[0]!.totals as Record<string, number | string>;
    expect(totals.reach).toBe(2850);
    expect(totals.reach_unit).toBe('individuals');
    expect(totals.frequency).toBeLessThanOrEqual(3);
  });

  it('binds a root cap into direct purchases and requotes changes outside accepted terms', async () => {
    await seedCatalog(server);
    const listed = await callTool(server, 'list_products', {
      account: ACCOUNT,
      criteria: { product_ids: ['fc_legacy_shared', 'fc_companion_shared'] },
      fields: ['pricing_options'],
    });
    expect(listed.error, JSON.stringify(listed.result)).toBeUndefined();
    const bought = await executeTrainingAgentTool('buy_products', {
      adcp_version: TRAINING_AGENT_CURRENT_ADCP_VERSION,
      idempotency_key: `buy-frequency-cap-${crypto.randomUUID()}`,
      account: ACCOUNT,
      feed_version: listed.result.feed_version,
      pricing_version: listed.result.pricing_version,
      frequency_cap: cap(3),
      purchases: [
        {
          product_id: 'fc_legacy_shared',
          pricing_option_id: 'fc_legacy_shared_cpm',
          budget: 5000,
          targeting_overlay: { frequency_cap: cap(5) },
        },
        { product_id: 'fc_companion_shared', pricing_option_id: 'fc_companion_shared_cpm', budget: 5000 },
      ],
      ...FLIGHT,
    }, { ...DEFAULT_CTX, principal: 'buyer' });
    expect(bought.success, bought.error).toBe(true);
    const data = bought.data as Record<string, unknown>;
    const acceptedProposal = data.accepted_proposal as Record<string, Record<string, unknown>>;
    expect(acceptedProposal.commercial_terms.frequency_cap).toEqual(cap(3));
    const mediaBuyId = data.media_buy_id as string;
    const buy = await readBuy(server, mediaBuyId);
    expect(buy.frequency_cap).toEqual(cap(3));

    const requote = await callTool(server, 'control_media_buy', {
      account: ACCOUNT, media_buy_id: mediaBuyId, revision: buy.revision, frequency_cap: cap(2),
    });
    expect(requote.error).toMatchObject({ code: 'REQUOTE_REQUIRED', field: 'frequency_cap' });

    // Package caps: capability precedes accepted terms. A cap the seller-wide
    // domain cannot execute reports UNSUPPORTED_FEATURE even though it also
    // differs from the accepted purchase; an executable change outside the
    // accepted purchase is a REQUOTE_REQUIRED.
    const bindings = data.purchase_bindings as Array<{ package_id: string }>;
    const cappedPackageId = bindings[0]!.package_id;
    const outsideCapability = await callTool(server, 'control_media_buy', {
      account: ACCOUNT,
      media_buy_id: mediaBuyId,
      revision: buy.revision,
      packages: [{ package_id: cappedPackageId, targeting_overlay: { frequency_cap: cap(5, 'custom') } }],
    });
    expect(outsideCapability.error).toMatchObject({ code: 'UNSUPPORTED_FEATURE' });
    const outsideTerms = await callTool(server, 'control_media_buy', {
      account: ACCOUNT,
      media_buy_id: mediaBuyId,
      revision: buy.revision,
      packages: [{ package_id: cappedPackageId, targeting_overlay: { frequency_cap: cap(3) } }],
    });
    expect(outsideTerms.error).toMatchObject({ code: 'REQUOTE_REQUIRED' });
  });
});
