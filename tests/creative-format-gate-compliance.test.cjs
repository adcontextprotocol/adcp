// adcp#8770: storyboards that send a fixed image creative must not fail a
// seller whose selected format option is a display tag or VAST format. The
// canonical dependency-impairment storyboards skip every creative phase when
// the first product's first format option is not an image format.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');
const { runStoryboard } = require('@adcp/sdk/testing');

const complianceRoot = process.env.ADCP_COMPLIANCE_TEST_ROOT || path.join(__dirname, '..', 'static', 'compliance', 'source');
const IMAGE_GATE = "context.format_kind != 'image'";
const GATED_STORYBOARDS = ['dependency_impairment', 'dependency_impairment_cardinality'];

function loadMediaBuyStoryboard(name) {
  return YAML.parse(fs.readFileSync(path.join(complianceRoot, 'protocols', 'media-buy', 'scenarios', `${name}.yaml`), 'utf8'));
}

for (const name of GATED_STORYBOARDS) {
  test(`${name}: every phase that sends or depends on the fixed image creative is format-gated`, () => {
    const storyboard = loadMediaBuyStoryboard(name);
    const [setup, ...rest] = storyboard.phases;
    assert.equal(setup.id, 'setup');
    assert.deepEqual(setup.steps.map(step => step.task), ['get_products', 'create_media_buy'],
      'the ungated setup phase only discovers the format and creates the buy');
    assert.equal(setup.skip_if, undefined);
    assert.ok(rest.length > 0);
    for (const phase of rest) {
      assert.equal(phase.skip_if, IMAGE_GATE, `${name}/${phase.id} runs only for an image format option`);
    }
    const imageSyncs = rest.flatMap(phase => phase.steps).filter(step => step.task === 'sync_creatives');
    assert.ok(imageSyncs.length > 0);
    for (const step of imageSyncs) {
      for (const creative of step.sample_request.creatives) {
        assert.equal(creative.format_kind, '$context.format_kind');
        assert.equal(creative.assets.image.asset_type, 'image', `${name}/${step.id} still sends the fixed image manifest`);
      }
    }
  });

  for (const formatKind of ['display_tag', 'video_vast']) {
    test(`${name}: a ${formatKind}-only seller is not sent the image creative and does not fail`, async () => {
      const source = loadMediaBuyStoryboard(name);
      // Response-schema conformance has its own coverage; these mock sellers
      // return only the fields the gate and buy creation read.
      const storyboard = {
        ...source,
        phases: source.phases.map(phase => ({
          ...phase,
          steps: phase.steps.map(step => ({
            ...step,
            validations: (step.validations ?? []).filter(validation => validation.check !== 'response_schema'),
          })),
        })),
      };
      const calls = [];
      const tools = ['get_adcp_capabilities', ...storyboard.required_tools];
      const result = await runStoryboard('https://seller.example/mcp', {
        ...storyboard, prerequisites: undefined, fixtures: undefined, requires: undefined,
      }, {
        _profile: { tools, raw_capabilities: {
          creative: { has_creative_library: true },
          media_buy: { propagation_surfaces: ['snapshot'] },
        } },
        agentTools: tools,
        _client: {
          resetContext() {},
          async getProducts(request) {
            calls.push('get_products');
            return { success: true, data: { products: [{
              product_id: 'tag-display',
              pricing_options: [{ pricing_option_id: 'tag-cpm', pricing_model: 'cpm', currency: 'USD', fixed_price: 12 }],
              format_options: [{ format_option_id: `tag-${formatKind}`, format_kind: formatKind, params: {} }],
            }], context: request.context } };
          },
          async createMediaBuy(request) {
            calls.push('create_media_buy');
            return { success: true, data: {
              media_buy_id: 'tag-buy',
              status: 'completed', media_buy_status: 'pending_creatives',
              packages: request.packages.map((pkg, i) => ({ ...pkg, package_id: `tag-package-${i}` })),
              context: request.context,
            } };
          },
          async syncCreatives() {
            calls.push('sync_creatives');
            throw new Error('the fixed image creative must not be sent to a non-image format option');
          },
        },
      });
      const failures = result.phases.flatMap(phase => phase.steps).filter(step => !step.passed);
      assert.deepEqual(failures, [], JSON.stringify(result.phases));
      assert.equal(result.failed_count, 0);
      assert.ok(!calls.includes('sync_creatives'), `calls: ${calls.join(', ')}`);
      assert.deepEqual(calls, ['get_products', 'create_media_buy']);
      const executed = result.phases.filter(phase => phase.steps.length > 0).map(phase => phase.phase_id);
      assert.deepEqual(executed, ['setup']);
    });
  }
}
