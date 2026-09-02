const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const YAML = require('yaml');

const ROOT = path.resolve(__dirname, '..');
const SOURCE = path.join(ROOT, 'static', 'schemas', 'source');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(SOURCE, relativePath), 'utf8'));
}

async function loadSchema(uri) {
  if (!uri.startsWith('/schemas/')) {
    throw new Error(`Unexpected schema URI: ${uri}`);
  }
  return readJson(uri.slice('/schemas/'.length));
}

async function compileSchema(uri) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema });
  return ajv.compileAsync(await loadSchema(uri));
}

test('flat-rate DOOH parameters express seller-packaged slot contiguity', async () => {
  const schema = readJson('pricing-options/flat-rate-option.json');
  const validate = await compileSchema('/schemas/pricing-options/flat-rate-option.json');
  const option = {
    pricing_option_id: 'unequal_loop',
    pricing_model: 'flat_rate',
    currency: 'USD',
    fixed_price: 5000,
    parameters: {
      type: 'dooh',
      sov_percentage: 25,
      slot_span: 2,
      loop_position: 'network_specific_position',
    },
  };

  assert.equal(validate(option), true, JSON.stringify(validate.errors));
  assert.equal(validate({
    ...option,
    parameters: { ...option.parameters, slot_span: 0 },
  }), false);
  assert.match(schema.properties.parameters.properties.sov_percentage.description, /divide sov_percentage by 100/);
  assert.match(schema.properties.parameters.properties.sov_percentage.description, /time-weighted/);
  assert.match(schema.properties.parameters.properties.loop_position.description, /open string/);
  assert.equal(schema.properties.parameters.properties.slot_span['x-added-in'], '3.2.0');
  assert.equal(schema.properties.parameters.properties.loop_position['x-added-in'], '3.2.0');
});

test('delivery SOV descriptions align scales and duration weighting', () => {
  const metrics = readJson('core/delivery-metrics.json').properties;
  const achieved = metrics.dooh_metrics.properties.sov_achieved.description;
  const contracted = metrics.ooh_metrics.properties.share_of_voice_contracted.description;

  assert.match(achieved, /multiply sov_achieved by 100/);
  assert.match(achieved, /time-weighted/);
  assert.match(contracted, /0\.0-1\.0 scale/);
  assert.match(contracted, /time-weighted/);
});

test('sales-dooh storyboard anchors unequal-segment time share', () => {
  const storyboard = YAML.parse(fs.readFileSync(
    path.join(ROOT, 'static', 'compliance', 'source', 'specialisms', 'sales-dooh', 'index.yaml'),
    'utf8',
  ));
  const option = storyboard.fixtures.pricing_options.find(
    candidate => candidate.pricing_option_id === 'dooh_transit_flat_unequal_loop',
  );
  const delivery = storyboard.phases
    .find(phase => phase.id === 'delivery')
    .steps.find(step => step.id === 'simulate_delivery');

  assert.deepEqual(option.parameters, {
    type: 'dooh',
    sov_percentage: 25,
    slot_span: 2,
    loop_position: 'adjacent_to_content_break',
  });
  assert.match(storyboard.phases.find(phase => phase.id === 'product_discovery').narrative, /\[10, 10, 20, 40\]/);
  assert.equal(delivery.sample_request.params.dooh_metrics.sov_achieved, 0.25);
  assert.equal(delivery.sample_request.params.dooh_metrics.screen_time_seconds, 2500);
});
