// adcp#8770: 3.1 storyboards must not fail a seller whose catalog offers only
// third-party display tags and VAST tags.
//
// - Storyboards that sync against the product's own format build the creative
//   from that format's declaration ($build_assets_from_format). A format the
//   test kit cannot fill grades not_applicable (fixture_unavailable) before
//   any buy is created.
// - Storyboards that push a fixed image or native creative run those phases
//   only when the seller declares a format of that shape.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { runStoryboard } = require('@adcp-protocol/fixture-test-sdk/testing');

const complianceRoot = process.env.ADCP_COMPLIANCE_TEST_ROOT || path.join(__dirname, '..', 'static', 'compliance', 'source');
const testKit = YAML.parse(fs.readFileSync(path.join(complianceRoot, 'test-kits', 'acme-outdoor.yaml'), 'utf8'));

const AGENT = 'https://seller.example';

function load(rel) {
  return YAML.parse(fs.readFileSync(path.join(complianceRoot, rel), 'utf8'));
}

function withoutResponseSchema(storyboard) {
  // Response-schema conformance has its own coverage; these mock sellers return
  // only the fields the gates, the asset builder and the buy flow read.
  return {
    ...storyboard,
    prerequisites: undefined,
    fixtures: undefined,
    requires: undefined,
    phases: storyboard.phases.map(phase => ({
      ...phase,
      steps: phase.steps.map(step => ({
        ...step,
        validations: (step.validations ?? []).filter(validation => validation.check !== 'response_schema'),
      })),
    })),
  };
}

function legacyFormat(id, assets) {
  return { format_id: { agent_url: AGENT, id }, name: id, assets };
}

const TAG_FORMATS = {
  display_tag: legacyFormat('display_tag', [
    { item_type: 'individual', asset_id: 'tag_markup', asset_type: 'html', required: true },
  ]),
  video_vast: legacyFormat('video_vast', [
    { item_type: 'individual', asset_id: 'vast_tag', asset_type: 'vast', required: true },
  ]),
};
const IMAGE_FORMAT = legacyFormat('display_300x250', [
  { item_type: 'individual', asset_id: 'banner', asset_type: 'image', required: true, requirements: { min_width: 300, max_width: 300, min_height: 250, max_height: 250 } },
  { item_type: 'individual', asset_id: 'landing', asset_type: 'url', required: true },
]);

function productDiscovery(calls, format) {
  return {
    async getProducts(request) {
      calls.push('get_products');
      return { success: true, data: { products: [{
        product_id: 'seller-display',
        pricing_options: [{ pricing_option_id: 'seller-cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 12 }],
        format_ids: [format.format_id],
      }], context: request.context } };
    },
    async listCreativeFormats(request) {
      calls.push('list_creative_formats');
      assert.deepEqual(request.format_ids, [format.format_id], 'the product format is resolved by its exact FormatId');
      return { success: true, data: { formats: [format], context: request.context } };
    },
  };
}

// ---------------------------------------------------------------- part 1
const DIRECTIVE_STORYBOARDS = [
  ['dependency_impairment', 'create_buy', 2],
  ['dependency_impairment_cardinality', 'create_buy_two_packages', 4],
];

for (const [name, createStep, creativeCount] of DIRECTIVE_STORYBOARDS) {
  const rel = `protocols/media-buy/scenarios/${name}.yaml`;

  test(`${name}: every test creative is built from the product's own format`, () => {
    const storyboard = load(rel);
    assert.ok(storyboard.required_tools.includes('list_creative_formats'));
    const steps = storyboard.phases.flatMap(phase => phase.steps);
    const ids = steps.map(step => step.id);
    assert.ok(ids.indexOf('list_selected_format') < ids.indexOf(createStep), 'the format resolves before any buy is created');
    const creatives = steps.filter(step => step.task === 'sync_creatives').flatMap(step => step.sample_request.creatives);
    assert.equal(creatives.length, creativeCount);
    for (const creative of creatives) {
      assert.equal(creative.format_id, '$context.format_ref');
      assert.deepEqual(creative.assets, { $build_assets_from_format: '$context.format_ref' });
    }
  });

  for (const [kind, format] of Object.entries(TAG_FORMATS)) {
    test(`${name}: a ${kind}-only seller is graded not_applicable before any buy is created`, async () => {
      const storyboard = withoutResponseSchema(load(rel));
      const calls = [];
      const tools = ['get_adcp_capabilities', ...storyboard.required_tools];
      const result = await runStoryboard(`${AGENT}/mcp`, storyboard, {
        _profile: { tools, raw_capabilities: {
          creative: { has_creative_library: true },
          media_buy: { propagation_surfaces: ['snapshot'] },
        } },
        agentTools: tools,
        test_kit: testKit,
        _client: {
          resetContext() {},
          ...productDiscovery(calls, format),
          async createMediaBuy() { calls.push('create_media_buy'); throw new Error('no buy may be created'); },
          async syncCreatives() { calls.push('sync_creatives'); throw new Error('no creative may be sent'); },
        },
      });
      const steps = result.phases.flatMap(phase => phase.steps);
      assert.equal(result.failed_count, 0, JSON.stringify(result.phases));
      assert.equal(result.overall_passed, true);
      assert.deepEqual(calls, ['get_products', 'list_creative_formats']);
      const gap = steps.filter(step => step.skip?.reason === 'fixture_unavailable');
      assert.equal(gap.length, 1);
      assert.match(gap[0].skip.detail, /^creative_asset_fixture_unavailable:/);
    });
  }

  test(`${name}: an image seller receives the kit image under its own declared asset ids`, async () => {
    const source = withoutResponseSchema(load(rel));
    const keep = new Set(['get_products', 'list_creative_formats', 'create_media_buy', 'sync_creatives']);
    const storyboard = {
      ...source,
      phases: [{ id: 'setup', title: 'Setup', steps: source.phases[0].steps.filter(step => keep.has(step.task)) }],
    };
    const calls = [];
    const syncs = [];
    const tools = ['get_adcp_capabilities', ...storyboard.required_tools];
    const result = await runStoryboard(`${AGENT}/mcp`, storyboard, {
      _profile: { tools, raw_capabilities: {
        creative: { has_creative_library: true },
        media_buy: { propagation_surfaces: ['snapshot'] },
      } },
      agentTools: tools,
      test_kit: testKit,
      _client: {
        resetContext() {},
        ...productDiscovery(calls, IMAGE_FORMAT),
        async createMediaBuy(request) {
          calls.push('create_media_buy');
          return { success: true, data: {
            media_buy_id: 'seller-buy', status: 'completed', media_buy_status: 'pending_creatives',
            packages: request.packages.map((pkg, i) => ({ ...pkg, package_id: `seller-package-${i}` })),
            context: request.context,
          } };
        },
        async syncCreatives(request) {
          calls.push('sync_creatives');
          syncs.push(request);
          return { success: true, data: {
            creatives: request.creatives.map(creative => ({ creative_id: creative.creative_id, action: 'created', status: 'approved' })),
            context: request.context,
          } };
        },
      },
    });
    assert.equal(result.failed_count, 0, JSON.stringify(result.phases));
    assert.deepEqual(calls, ['get_products', 'list_creative_formats', 'create_media_buy', 'sync_creatives']);
    for (const creative of syncs[0].creatives) {
      assert.deepEqual(creative.format_id, IMAGE_FORMAT.format_id);
      assert.deepEqual(Object.keys(creative.assets).sort(), ['banner', 'landing']);
      assert.equal(creative.assets.banner.asset_type, 'image');
      assert.equal(creative.assets.banner.width, 300);
      assert.equal(creative.assets.banner.height, 250);
      assert.equal(creative.assets.landing.url, testKit.assets.click_url);
    }
  });
}

test('media_buy_seller: creative_sync builds the roundtrip creative from the product format and runs last', () => {
  const storyboard = load('protocols/media-buy/index.yaml');
  const phases = storyboard.phases.map(phase => phase.id);
  assert.equal(phases.at(-1), 'creative_sync', 'a creative fixture gap ends the storyboard, so it runs after delivery');
  const creativeSync = storyboard.phases.at(-1);
  assert.deepEqual(creativeSync.depends_on, ['create_buy']);
  const [listFormats, sync] = creativeSync.steps;
  assert.deepEqual(listFormats.context_outputs, [{ path: 'formats', key: 'formats' }]);
  assert.deepEqual(listFormats.context_inputs, [{ key: 'product_format_id', inject_at: 'format_ids[0]' }]);
  assert.deepEqual(sync.sample_request.creatives, [{
    creative_id: 'trail_pro_product_format',
    name: 'Trail Pro 3000 - product format',
    format_id: '$context.product_format_id',
    assets: { $build_assets_from_format: '$context.product_format_id' },
  }]);
});

// ---------------------------------------------------------------- part 2
const GATED = [
  ['protocols/creative/index.yaml', 'image', ['sync_multiple', 'list_and_filter', 'build_and_preview']],
  [
    'protocols/creative/scenarios/creative_lifecycle_webhooks.yaml',
    'image',
    ['register_account_lifecycle_subscriber', 'seed_creative', 'status_changed_event', 'purged_event_optional'],
  ],
  ['universal/deterministic-testing.yaml', 'image', ['deterministic_creative']],
  ['protocols/creative/scenarios/native_in_feed.yaml', 'native', ['sync_native_creative', 'validation_failures', 'preview_native']],
  ['protocols/media-buy/scenarios/creative_reception.yaml', 'native', ['push_creatives', 'preview']],
];

for (const [rel, shape, gatedPhases] of GATED) {
  test(`${rel}: every phase that pushes the fixed creative is skipped once the seller confirms no ${shape} format`, () => {
    const storyboard = load(rel);
    const found = `${shape}_formats`;
    const marker = `no_${shape}_formats`;
    const byId = new Map(storyboard.phases.map(phase => [phase.id, phase]));
    for (const id of gatedPhases) assert.equal(byId.get(id)?.skip_if, `context.${marker}`, `${rel}/${id}`);
    const syncPhases = storyboard.phases.filter(phase => phase.steps.some(step => step.task === 'sync_creatives'));
    for (const phase of syncPhases) assert.equal(phase.skip_if, `context.${marker}`, `${rel}/${phase.id} pushes a creative`);

    const producerOf = key => storyboard.phases.findIndex(phase =>
      phase.steps.some(step => step.task === 'list_creative_formats' &&
        step.context_outputs?.some(output => output.key === key && output.path === 'formats')));
    const query = producerOf(found);
    const confirm = producerOf(marker);
    assert.ok(query >= 0 && confirm > query, `${rel}: the query, then the confirmation`);
    // The confirmation runs only when the query ran and returned an empty list.
    assert.equal(storyboard.phases[confirm].skip_if, `!context.${found} || context.${found}.0`);
    for (const id of gatedPhases) {
      assert.ok(storyboard.phases.findIndex(phase => phase.id === id) > confirm, `${id} runs after the confirmation`);
    }
  });
}

function shapeAwareFormats(calls, { image, native }) {
  return async function listCreativeFormats(request) {
    calls.push('list_creative_formats');
    const types = request.asset_types ?? [];
    let formats = Object.values(TAG_FORMATS);
    if (types.includes('text')) formats = native ? [legacyFormat('native_in_feed', [])] : [];
    else if (types.includes('image')) formats = image ? [IMAGE_FORMAT] : [];
    return { success: true, data: { formats, context: request.context } };
  };
}

const RUNNABLE = [
  ['creative_lifecycle', 'protocols/creative/index.yaml', null, ['list_creative_formats', 'sync_creatives', 'list_creatives']],
  ['native_in_feed', 'protocols/creative/scenarios/native_in_feed.yaml', null, ['sync_creatives']],
  ['creative_reception', 'protocols/media-buy/scenarios/creative_reception.yaml', null, ['sync_creatives']],
  [
    'deterministic_testing',
    'universal/deterministic-testing.yaml',
    ['deterministic_creative_formats', 'deterministic_creative_no_image_formats', 'deterministic_creative'],
    ['comply_test_controller', 'sync_creatives'],
  ],
];

const SELLERS = [
  // [label, advertises list_creative_formats, catalog offers the shape, creative expected]
  ['a tag-and-VAST-only seller is not sent', true, false, false],
  ['an image-or-native seller is sent', true, true, true],
  ['a seller without list_creative_formats is still sent', false, false, true],
];

for (const [name, rel, onlyPhases, baseTools] of RUNNABLE) {
  for (const [label, listsFormats, offersShape, expectSync] of SELLERS) {
    if (!listsFormats && name === 'creative_lifecycle') continue; // list_creative_formats is a required tool there
    test(`${name}: ${label} the fixed creative`, async () => {
      const source = withoutResponseSchema(load(rel));
      const storyboard = onlyPhases
        ? { ...source, phases: source.phases.filter(phase => onlyPhases.includes(phase.id)) }
        : source;
      const calls = [];
      const tools = [...new Set(['get_adcp_capabilities', ...(storyboard.required_tools ?? []), ...baseTools,
        ...(listsFormats ? ['list_creative_formats'] : [])])];
      const result = await runStoryboard(`${AGENT}/mcp`, storyboard, {
        _profile: { tools, raw_capabilities: { supported_protocols: ['media_buy', 'creative'], creative: { has_creative_library: true } } },
        agentTools: tools,
        test_kit: testKit,
        _client: {
          resetContext() {},
          async getAdcpCapabilities(request) {
            calls.push('get_adcp_capabilities');
            return { success: true, data: { adcp: { major_versions: [3] }, supported_protocols: ['media_buy', 'creative'], context: request?.context } };
          },
          listCreativeFormats: shapeAwareFormats(calls, { image: offersShape, native: offersShape }),
          async syncCreatives(request) {
            calls.push('sync_creatives');
            return { success: true, data: {
              creatives: request.creatives.map(creative => ({ creative_id: creative.creative_id, action: 'created', status: 'approved' })),
              context: request.context,
            } };
          },
        },
      });
      assert.equal(calls.includes('sync_creatives'), expectSync, `calls: ${calls.join(', ')}`);
      if (!listsFormats) assert.ok(!calls.includes('list_creative_formats'));
      if (!expectSync) assert.equal(result.failed_count, 0, JSON.stringify(result.phases));
    });
  }
}
