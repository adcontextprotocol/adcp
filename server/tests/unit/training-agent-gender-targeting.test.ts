import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createTrainingAgentServer, clearTaskStore, invalidateCache } from '../../src/training-agent/task-handlers.js';
import { clearSessions } from '../../src/training-agent/state.js';
import { clearIdempotencyCache } from '../../src/training-agent/idempotency.js';
import { validateSourceSchema } from '../../src/training-agent/source-schema.js';
const CANDIDATE_VERSION = '3.3-beta.0';

const account = { brand: { domain: 'acmeoutdoor.example' }, operator: 'pinnacle-agency.example', sandbox: true };
const age = { min: 18, max: 55, include_unknown: false };
const gender = { values: ['female', 'non_binary'], include_unknown: false };
const nativeCapability = {
  age: {
    execution_modes: ['continuous_bounds'], min_supported_age: 18, max_supported_age: 65,
    supports_unbounded_min: true, supports_unbounded_max: true, unknown_handling: 'selectable',
  },
  gender: { execution_modes: ['native'], values: ['female', 'male', 'non_binary'], unknown_handling: 'selectable' },
};

describe('training seller core gender targeting', () => {
  let server: ReturnType<typeof createTrainingAgentServer>;

  beforeEach(async () => {
    await clearSessions();
    clearIdempotencyCache();
    clearTaskStore();
    invalidateCache();
    server = createTrainingAgentServer({ mode: 'open', authenticatedAgentUrl: 'https://buyer.example', developmentCoreGender: true });
  });

  async function call(tool: string, args: Record<string, unknown>) {
    const handler = (server as unknown as { _requestHandlers: Map<string, Function> })._requestHandlers.get('tools/call')!;
    const response = await handler({ method: 'tools/call', params: {
      name: tool, arguments: { adcp_version: CANDIDATE_VERSION, idempotency_key: randomUUID(), ...args },
    } }, {});
    const result = (response.structuredContent ?? JSON.parse(response.content[0].text)) as Record<string, any>;
    return result.adcp_error ? { errors: [result.adcp_error] } : result;
  }

  async function seed(capability: Record<string, unknown>, options: Record<string, unknown> = {}) {
    const productId = `gender_product_${randomUUID()}`;
    expect(await call('comply_test_controller', {
      account, brand: account.brand, scenario: 'seed_product', params: {
        product_id: productId, fixture: {
          channels: ['display'], delivery_type: 'non_guaranteed',
          overlay_support: { demographics: { age: true, gender: true }, geo_countries: true },
          demographic_targeting: capability, ...options,
        },
      },
    })).toMatchObject({ success: true });
    expect(await call('comply_test_controller', {
      account, brand: account.brand, scenario: 'seed_pricing_option', params: {
        product_id: productId, pricing_option_id: 'gender_cpm',
        fixture: { pricing_model: 'cpm', currency: 'USD', fixed_price: 10 },
      },
    })).toMatchObject({ success: true });
    return productId;
  }

  async function create(productId: string, demographics: Record<string, unknown>) {
    return call('create_media_buy', {
      account, brand: account.brand,
      start_time: new Date(Date.now() + 30 * 86400000).toISOString(),
      end_time: new Date(Date.now() + 60 * 86400000).toISOString(),
      packages: [{ product_id: productId, pricing_option_id: 'gender_cpm', budget: 1000,
        targeting_overlay: { geo_countries: ['US'], demographics } }],
    });
  }

  it('declares experimental gender on candidate capabilities and isolates the 3.2 contract', async () => {
    await seed(nativeCapability);
    const candidate = await call('get_adcp_capabilities', {});
    expect(candidate.media_buy.execution.targeting.demographics.gender.supported).toBe(true);
    expect(candidate.experimental_features).toContain('media_buy.gender_targeting');
    const validation = validateSourceSchema('protocol/get-adcp-capabilities-response.json', candidate);
    expect(validation.valid, JSON.stringify(validation.errors)).toBe(true);
    const stable = await call('get_adcp_capabilities', { adcp_version: '3.2' });
    expect(stable.media_buy.execution.targeting).not.toHaveProperty('demographics.gender');
    expect(stable.experimental_features ?? []).not.toContain('media_buy.gender_targeting');
  });

  it('keeps non-binary gender-only intent in create and audit without fabricating age', async () => {
    const productId = await seed(nativeCapability);
    const created = await create(productId, { gender });
    expect(created, JSON.stringify(created)).not.toHaveProperty('errors');
    expect(created).toMatchObject({ packages: [{ targeting_overlay: { demographics: { gender } },
      targeting_resolution: { demographics: { requested: { gender }, applied: { gender }, equivalent: true,
        execution: { type: 'gender_values' } } } }] });
    expect(created.packages[0].targeting_resolution.demographics.applied).not.toHaveProperty('age');
    const audit = await call('get_media_buys', { account, media_buy_ids: [created.media_buy_id] });
    expect(audit).toMatchObject({ media_buys: [{ packages: [{ targeting_resolution: created.packages[0].targeting_resolution }] }] });
    expect(validateSourceSchema('media-buy/get-media-buys-response.json', audit).valid).toBe(true);
  });

  it('refreshes mixed execution and clears whole demographics while preserving geography', async () => {
    const productId = await seed(nativeCapability);
    const created = await create(productId, { age, gender });
    expect(created, JSON.stringify(created)).not.toHaveProperty('errors');
    expect(created.packages[0].targeting_resolution.demographics.execution).toEqual({
      type: 'per_dimension', age: { type: 'continuous_bounds' }, gender: { type: 'gender_values' },
    });
    const packageId = created.packages[0].package_id;
    const revisedGender = { values: ['non_binary'], include_unknown: true };
    const changed = await call('update_media_buy', { account, media_buy_id: created.media_buy_id,
      revision: created.revision, packages: [{ package_id: packageId,
        targeting_overlay: { demographics: { age, gender: revisedGender } } }] });
    expect(changed, JSON.stringify(changed)).not.toHaveProperty('errors');
    expect(changed.status).toBe('completed');
    const updateValidation = validateSourceSchema('media-buy/update-media-buy-response.json', changed);
    expect(updateValidation.valid, JSON.stringify(updateValidation.errors)).toBe(true);
    expect(changed.affected_packages[0]).toMatchObject({ targeting_overlay: { geo_countries: ['US'], demographics: { age, gender: revisedGender } },
      targeting_resolution: { demographics: { requested: { age, gender: revisedGender }, applied: { age, gender: revisedGender } } } });
    const genderOnly = await call('update_media_buy', { account, media_buy_id: created.media_buy_id,
      revision: changed.revision, packages: [{ package_id: packageId,
        targeting_overlay: { demographics: { gender: revisedGender } } }] });
    expect(genderOnly, JSON.stringify(genderOnly)).not.toHaveProperty('errors');
    expect(genderOnly.affected_packages[0].targeting_overlay).toEqual({ geo_countries: ['US'], demographics: { gender: revisedGender } });
    expect(genderOnly.affected_packages[0].targeting_resolution.demographics.execution).toEqual({ type: 'gender_values' });
    const cleared = await call('update_media_buy', { account, media_buy_id: created.media_buy_id,
      revision: genderOnly.revision, packages: [{ package_id: packageId, targeting_overlay: { demographics: null } }] });
    expect(cleared, JSON.stringify(cleared)).not.toHaveProperty('errors');
    expect(cleared.affected_packages[0].targeting_overlay).toEqual({ geo_countries: ['US'] });
    expect(cleared.affected_packages[0]).not.toHaveProperty('targeting_resolution');
    const audit = await call('get_media_buys', { account, media_buy_ids: [created.media_buy_id] });
    expect(audit.media_buys[0].packages[0].targeting_overlay).toEqual({ geo_countries: ['US'] });
    expect(audit.media_buys[0].packages[0]).not.toHaveProperty('targeting_resolution');
  });

  it('keeps literal prototype keys from becoming inherited targeting dimensions', async () => {
    const productId = await seed(nativeCapability);
    const created = await create(productId, { gender });
    expect(created, JSON.stringify(created)).not.toHaveProperty('errors');
    const targeting = JSON.parse('{"__proto__":{"property_list":{"agent_url":"https://publisher.example","list_id":"nested-list"}}}');
    const changed = await call('update_media_buy', { account, media_buy_id: created.media_buy_id,
      revision: created.revision, packages: [{ package_id: created.packages[0].package_id,
        targeting_overlay: targeting }] });
    expect(changed, JSON.stringify(changed)).not.toHaveProperty('errors');
    const overlay = changed.affected_packages[0].targeting_overlay;
    expect(overlay).not.toHaveProperty('property_list');
    expect(overlay).toMatchObject({ geo_countries: ['US'], demographics: { gender } });
    expect(Object.hasOwn(overlay, '__proto__')).toBe(true);
    expect(overlay.__proto__).toEqual(targeting.__proto__);
    const audit = await call('get_media_buys', { account, media_buy_ids: [created.media_buy_id] });
    expect(audit.media_buys[0].packages[0].targeting_overlay).toEqual(overlay);
  });

  it('rejects undeclared, unsupported-category and incompatible unknown predicates before create', async () => {
    const productId = await seed({ gender: {
      execution_modes: ['native'], values: ['female', 'male'], unknown_handling: 'always_excluded',
    } });
    for (const requested of [gender, { values: ['female'], include_unknown: true }]) {
      const result = await create(productId, { gender: requested });
      expect(result).toMatchObject({ errors: [{ code: 'UNSUPPORTED_FEATURE', field: 'packages[0].targeting_overlay.demographics.gender' }] });
      expect(result).not.toHaveProperty('media_buy_id');
    }
    const ageOnlyId = await seed({ age: nativeCapability.age });
    expect(await create(ageOnlyId, { gender })).toMatchObject({ errors: [{ code: 'UNSUPPORTED_FEATURE' }] });
  });

  it('executes exact gender signal unions and rejects correlated age projection', async () => {
    const signalCapability = { gender: { ...nativeCapability.gender, execution_modes: ['signals'] } };
    const productId = await seed(signalCapability, { signal_targeting_allowed: true, signal_targeting_options: [
      { signal_ref: { scope: 'product', signal_id: 'female' }, name: 'Female audience', value_type: 'binary',
        restricted_attributes: ['sex_gender'], demographic_predicate: { gender: { values: ['female'], include_unknown: false } } },
      { signal_ref: { scope: 'product', signal_id: 'non_binary' }, name: 'Non-binary audience', value_type: 'binary',
        restricted_attributes: ['sex_gender'], demographic_predicate: { gender: { values: ['non_binary'], include_unknown: false } } },
    ] });
    const created = await create(productId, { gender });
    expect(created, JSON.stringify(created)).not.toHaveProperty('errors');
    expect(created.packages[0].targeting_resolution.demographics.execution).toEqual({ type: 'signals', signal_refs: [
      { scope: 'product', signal_id: 'female' }, { scope: 'product', signal_id: 'non_binary' },
    ] });
    const correlatedId = await seed(signalCapability, { signal_targeting_allowed: true, signal_targeting_options: [
      { signal_ref: { scope: 'product', signal_id: 'correlated' }, name: 'Female and non-binary adults', value_type: 'binary',
        restricted_attributes: ['age', 'sex_gender'], demographic_predicate: { age, gender } },
    ] });
    expect(await create(correlatedId, { gender })).toMatchObject({ errors: [{ code: 'UNSUPPORTED_FEATURE' }] });
  });

  it('distinguishes independent mixed execution from an exact joint signal and rejects reversed joint bounds', async () => {
    const signal = { signal_ref: { scope: 'product', signal_id: 'gender_members' }, name: 'Female and non-binary audience',
      value_type: 'binary', restricted_attributes: ['sex_gender'], demographic_predicate: { gender } };
    const mixedId = await seed({ ...nativeCapability, gender: { ...nativeCapability.gender, execution_modes: ['signals'] } }, {
      signal_targeting_allowed: true, signal_targeting_options: [signal],
    });
    const mixed = await create(mixedId, { age, gender });
    expect(mixed, JSON.stringify(mixed)).not.toHaveProperty('errors');
    expect(mixed.packages[0].targeting_resolution.demographics.execution).toEqual({ type: 'per_dimension',
      age: { type: 'continuous_bounds' }, gender: { type: 'signals', signal_refs: [signal.signal_ref] } });
    const jointCapability = { age: { execution_modes: ['signals'], unknown_handling: 'selectable' },
      gender: { ...nativeCapability.gender, execution_modes: ['signals'] } };
    const jointSignal = { ...signal, restricted_attributes: ['age', 'sex_gender'], demographic_predicate: { age, gender } };
    const jointId = await seed(jointCapability, { signal_targeting_allowed: true, signal_targeting_options: [jointSignal] });
    const joint = await create(jointId, { age, gender });
    expect(joint, JSON.stringify(joint)).not.toHaveProperty('errors');
    expect(joint.packages[0].targeting_resolution.demographics.execution).toEqual({ type: 'signals', signal_refs: [signal.signal_ref] });
    const reversed = { min: 55, max: 18, include_unknown: false };
    const invalidId = await seed(jointCapability, { signal_targeting_allowed: true, signal_targeting_options: [
      { ...jointSignal, demographic_predicate: { age: reversed, gender } },
    ] });
    expect(await create(invalidId, { age: reversed, gender })).toMatchObject({ errors: [{ code: 'INVALID_REQUEST' }] });
  });

  it('retains executable gender capability under compact discovery projection and excludes unsupported products', async () => {
    const supported = await seed(nativeCapability);
    const unsupported = await seed({ age: nativeCapability.age });
    const listed = await call('list_products', { account, criteria: {
      product_ids: [supported, unsupported], targeting_overlay: { demographics: { gender } },
    }, fields: ['description'] });
    expect(listed, JSON.stringify(listed)).toMatchObject({ outcome: 'listed', products: [{ demographic_targeting: nativeCapability }] });
    expect(listed.products).toHaveLength(1);
    expect(validateSourceSchema('core/canonical-product.json', listed.products[0]).valid).toBe(true);
  });

  it('commits compact direct purchases with gender preserved in the accepted snapshot and package audit', async () => {
    const productId = await seed(nativeCapability);
    const listed = await call('list_products', { account, criteria: { product_ids: [productId] } });
    const purchased = await call('buy_products', {
      account, feed_version: listed.feed_version, pricing_version: listed.pricing_version,
      start_time: new Date(Date.now() + 30 * 86400000).toISOString(),
      end_time: new Date(Date.now() + 60 * 86400000).toISOString(),
      purchases: [{ product_id: productId, pricing_option_id: 'gender_cpm', budget: 1000,
        targeting_overlay: { demographics: { gender } } }],
    });
    expect(purchased, JSON.stringify(purchased)).not.toHaveProperty('errors');
    expect(purchased.accepted_proposal.commercial_terms.purchases[0].targeting_overlay).toEqual({ demographics: { gender } });
    const audited = await call('get_media_buys', { account, media_buy_ids: [purchased.media_buy_id] });
    expect(audited.media_buys[0].packages[0]).toMatchObject({
      package_id: purchased.purchase_bindings[0].package_id,
      targeting_overlay: { demographics: { gender } },
      targeting_resolution: { demographics: { requested: { gender }, applied: { gender }, execution: { type: 'gender_values' } } },
    });
  });

  it('isolates the candidate contract and rejects old-version readback of stored core gender', async () => {
    const capabilities = await call('get_adcp_capabilities', { adcp_version: '3.2' });
    expect(capabilities.media_buy.execution.targeting).not.toHaveProperty('demographics.gender');
    const stableCatalog = await call('get_products', { adcp_version: '3.2', account,
      buying_mode: 'wholesale', filters: { channels: ['display'] } });
    expect(stableCatalog, JSON.stringify(stableCatalog)).not.toHaveProperty('errors');
    for (const product of stableCatalog.products) {
      expect(product.demographic_targeting ?? {}).not.toHaveProperty('gender');
      expect(product.overlay_support?.demographics ?? {}).not.toHaveProperty('gender');
    }
    const productId = await seed(nativeCapability);
    expect(await call('list_products', { adcp_version: '3.2', account,
      criteria: { targeting_overlay: { demographics: { gender } } } })).toMatchObject({ errors: [{ code: 'UNSUPPORTED_FEATURE' }] });
    expect(await call('comply_test_controller', { adcp_version: '3.2', account, brand: account.brand,
      scenario: 'seed_product', params: { product_id: 'old_version_metadata', fixture: {
        signal_targeting_options: [{ restricted_attributes: ['sex_gender'] }],
      } } })).toMatchObject({ errors: [{ code: 'UNSUPPORTED_FEATURE' }] });
    const created = await create(productId, { gender });
    expect(await call('get_media_buys', { adcp_version: '3.2', account,
      media_buy_ids: [created.media_buy_id] })).toMatchObject({ errors: [{ code: 'UNSUPPORTED_FEATURE' }] });
    expect(await call('update_media_buy', { adcp_version: '3.2', account, media_buy_id: created.media_buy_id,
      revision: created.revision, packages: [{ package_id: created.packages[0].package_id, budget: 2000 }] }))
      .toMatchObject({ errors: [{ code: 'UNSUPPORTED_FEATURE' }] });
    expect((await call('get_media_buys', { account, media_buy_ids: [created.media_buy_id] })).media_buys[0])
      .toMatchObject({ revision: created.revision, packages: [{ budget: 1000 }] });
    server = createTrainingAgentServer({ mode: 'open', authenticatedAgentUrl: 'https://buyer.example' });
    expect(await call('get_adcp_capabilities', {})).toMatchObject({ errors: [{ code: 'VERSION_UNSUPPORTED' }] });
    const stable = await call('get_adcp_capabilities', { adcp_version: '3.2' });
    expect(stable.adcp.supported_versions).not.toContain(CANDIDATE_VERSION);
  });

  it('rejects malformed demographic replacement atomically instead of silently removing gender', async () => {
    const productId = await seed(nativeCapability);
    const created = await create(productId, { age, gender });
    for (const demographics of ['bad', { unexpected_dimension: true }, { gender: null }]) {
      const result = await call('update_media_buy', { account, media_buy_id: created.media_buy_id,
        revision: created.revision, packages: [{ package_id: created.packages[0].package_id,
          budget: 2000, targeting_overlay: { demographics } }] });
      expect(result).toHaveProperty('errors');
    }
    const audited = await call('get_media_buys', { account, media_buy_ids: [created.media_buy_id] });
    expect(audited.media_buys[0]).toMatchObject({ revision: created.revision,
      packages: [{ budget: 1000, targeting_overlay: { demographics: { age, gender } } }] });
  });

  it('keeps opaque vendor demographic breakdowns usable on the published 3.2 contract', async () => {
    const metric = { vendor: { domain: 'measurement.example' }, metric_id: 'panel_composition', value: 1,
      breakdown: { demographics: { gender: 'vendor-defined-panel-label' }, restricted_attributes: ['sex_gender'] } };
    const productId = await seed(nativeCapability, { reporting_capabilities: {
      available_metrics: ['impressions', 'spend'], vendor_metrics: [{ vendor: metric.vendor, metric_id: metric.metric_id }],
    } });
    const created = await create(productId, { age });
    expect(created, JSON.stringify(created)).not.toHaveProperty('errors');
    const simulation = await call('comply_test_controller', { adcp_version: '3.2', account, brand: account.brand,
      scenario: 'simulate_delivery', params: { media_buy_id: created.media_buy_id, impressions: 1000,
        spend: 10, vendor_metric_values: [metric] } });
    expect(simulation, JSON.stringify(simulation)).toMatchObject({ success: true });
    const delivery = await call('get_media_buy_delivery', { adcp_version: '3.2', account,
      media_buy_ids: [created.media_buy_id], end_date: '2099-01-01' });
    expect(delivery, JSON.stringify(delivery)).not.toHaveProperty('errors');
    expect(delivery.media_buy_deliveries[0].by_package[0].vendor_metric_values).toEqual([metric]);
  });

  it('rejects governed create and preserved or new-package gender before changing the buy', async () => {
    const productId = await seed(nativeCapability);
    const flight = { start_time: new Date(Date.now() + 30 * 86400000).toISOString(),
      end_time: new Date(Date.now() + 60 * 86400000).toISOString() };
    const pkg = { product_id: productId, pricing_option_id: 'gender_cpm', budget: 1000,
      targeting_overlay: { demographics: { gender } } };
    expect(await call('create_media_buy', { account, brand: account.brand, ...flight,
      governance_context: 'unsupported-evaluator-test-token', packages: [pkg] }))
      .toMatchObject({ errors: [{ code: 'UNSUPPORTED_FEATURE' }] });
    const created = await create(productId, { gender });
    for (const mutation of [
      { packages: [{ package_id: created.packages[0].package_id, budget: 2000 }] },
      { new_packages: [pkg] },
    ]) {
      expect(await call('update_media_buy', { account, media_buy_id: created.media_buy_id,
        revision: created.revision, governance_context: 'unsupported-evaluator-test-token', ...mutation }))
        .toMatchObject({ errors: [{ code: 'UNSUPPORTED_FEATURE' }] });
    }
    const audited = await call('get_media_buys', { account, media_buy_ids: [created.media_buy_id] });
    expect(audited.media_buys[0]).toMatchObject({ revision: created.revision, packages: [{ budget: 1000 }] });
    expect(audited.media_buys[0].packages).toHaveLength(1);
    const listed = await call('list_products', { account, criteria: { product_ids: [productId] } });
    expect(await call('buy_products', { account, ...flight, feed_version: listed.feed_version,
      pricing_version: listed.pricing_version, governance_context: 'unsupported-evaluator-test-token', purchases: [pkg] }))
      .toMatchObject({ errors: [{ code: 'UNSUPPORTED_FEATURE' }] });
    expect(await call('comply_test_controller', { account, brand: account.brand, scenario: 'seed_plan',
      params: { plan_id: 'gender_governance_plan', fixture: { brand: account.brand,
        budget: { total: 10000, currency: 'USD' } } } })).toMatchObject({ success: true });
    expect(await create(productId, { gender })).toMatchObject({ errors: [{ code: 'UNSUPPORTED_FEATURE' }] });
    expect(await call('update_media_buy', { account, media_buy_id: created.media_buy_id,
      revision: created.revision, packages: [{ package_id: created.packages[0].package_id, budget: 2000 }] }))
      .toMatchObject({ errors: [{ code: 'UNSUPPORTED_FEATURE' }] });
    const decreased = await call('update_media_buy', { account, media_buy_id: created.media_buy_id,
      revision: created.revision, packages: [{ package_id: created.packages[0].package_id, budget: 500 }] });
    expect(decreased, JSON.stringify(decreased)).not.toHaveProperty('errors');
    expect(decreased.affected_packages[0]).toMatchObject({ budget: 500, targeting_overlay: { demographics: { gender } } });
  });

  it('inherits configured demographics on omission and requires a requote for incomplete replacement', async () => {
    await seed(nativeCapability);
    const discovered = await call('get_products', { account, buying_mode: 'brief', brief: 'Display for adults',
      filters: { channels: ['display'], pricing_currencies: ['USD'] },
      targeting_overlay: { demographics: { age, gender } } });
    expect(discovered, JSON.stringify(discovered)).not.toHaveProperty('errors');
    const configured = discovered.products.find((product: Record<string, unknown>) => product.is_custom
      && (product.demographic_targeting as Record<string, unknown> | undefined)?.gender);
    expect(configured, JSON.stringify(discovered)).toBeDefined();
    const flight = { start_time: new Date(Date.now() + 30 * 86400000).toISOString(),
      end_time: new Date(Date.now() + 60 * 86400000).toISOString() };
    const pkg = { product_id: configured.product_id, pricing_option_id: configured.pricing_options[0].pricing_option_id, budget: 1000 };
    const inherited = await call('create_media_buy', { account, brand: account.brand, ...flight, packages: [pkg] });
    expect(inherited, JSON.stringify(inherited)).toMatchObject({ packages: [{ targeting_overlay: { demographics: { age, gender } } }] });
    for (const demographics of [{ age }, null]) {
      const replaced = await call('create_media_buy', { account, brand: account.brand, ...flight,
        packages: [{ ...pkg, targeting_overlay: { demographics } }] });
      expect(replaced, JSON.stringify(replaced)).toMatchObject({ errors: [{ code: 'REQUOTE_REQUIRED' }] });
    }
    expect(await call('create_media_buy', { account, brand: account.brand, ...flight,
      governance_context: 'unsupported-evaluator-test-token', packages: [pkg] }))
      .toMatchObject({ errors: [{ code: 'UNSUPPORTED_FEATURE' }] });
  });
});
