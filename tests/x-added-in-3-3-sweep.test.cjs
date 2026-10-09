/**
 * 3.3 coherence: every property and enum file new in 3.3 carries
 * `x-added-in: "3.3.0"`, the only machine-readable "new in 3.3" marker SDK
 * generators have. Surfaces that shipped in 3.2 must not carry it.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'static', 'schemas', 'source');
const load = (f) => JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));
const at = (obj, keys) => keys.reduce((o, k) => o[k], obj);

const WHOLE_FILE_3_3 = [
  'core/audience-size.json',
  'enums/audience-size-precision.json',
  'enums/audience-match-rate-basis.json',
  'core/definition-pin.json',
  'enums/definition-pin-ref-kind.json',
  'error-details/reference-definition-changed.json',
  'enums/spot-status.json',
  'core/dooh-inventory-summary.json',
  'core/catalog-ingestion-capability.json',
];

const PROPERTIES_3_3 = [
  ['media-buy/sync-audiences-response.json', ['oneOf', 0, 'properties', 'audiences', 'items', 'properties', 'audience_size']],
  ['media-buy/sync-audiences-response.json', ['oneOf', 0, 'properties', 'audiences', 'items', 'properties', 'targetable_size']],
  ['media-buy/sync-audiences-response.json', ['oneOf', 0, 'properties', 'audiences', 'items', 'properties', 'match_rate_basis']],
  ['media-buy/commercial-terms.json', ['properties', 'definition_pins']],
  ['core/spot-reporting-capability.json', ['properties', 'available_statuses']],
  ['core/spot-reporting-capability.json', ['properties', 'supports_break_position']],
  ['core/media-buy-features.json', ['properties', 'catalog_ingestion']],
  ['core/media-buy-features.json', ['properties', 'supports_property_breakdown']],
  ['core/media-buy-features.json', ['properties', 'supports_installment_property_breakdown']],
  ['core/canonical-placement.json', ['definitions', 'CanonicalDoohPlacementAttributes', 'properties', 'location']],
  ['core/placement-definition.json', ['definitions', 'PublisherDoohPlacementAttributes', 'properties', 'location']],
  ['core/placement.json', ['definitions', 'ProductDoohPlacementAttributes', 'properties', 'location']],
  ['core/canonical-product.json', ['properties', 'dooh_inventory_summary']],
  ['core/product.json', ['properties', 'dooh_inventory_summary']],
  ['core/delivery-metrics.json', ['properties', 'print_metrics']],
  ['core/reporting-webhook.json', ['properties', 'operation_id']],
  ['governance/sync-plans-request.json', ['properties', 'plans', 'items', 'properties', 'budget', 'properties', 'periods']],
  ['protocol/get-adcp-capabilities-response.json', ['properties', 'governance', 'properties', 'supports_budget_periods']],
  ['protocol/get-adcp-capabilities-response.json', ['properties', 'request_signing', 'properties', 'operation_sources']],
  ['formats/canonical/video_hosted.json', ['properties', 'loudness']],
];

test('whole-file 3.3 schemas and enums carry x-added-in 3.3.0', () => {
  for (const f of WHOLE_FILE_3_3) assert.equal(load(f)['x-added-in'], '3.3.0', f);
});

test('3.3 properties carry x-added-in 3.3.0', () => {
  for (const [f, keys] of PROPERTIES_3_3) {
    assert.equal(at(load(f), keys)['x-added-in'], '3.3.0', `${f} ${keys.join('.')}`);
  }
});

test('by_spot lifecycle fields carry x-added-in 3.3.0', () => {
  const resp = load('media-buy/get-media-buy-delivery-response.json');
  const spot = resp.properties.media_buy_deliveries.items.properties.by_package.items.allOf[1].properties.by_spot.items.allOf[1].properties;
  for (const k of ['spot_status', 'scheduled_at', 'replaces_spot_id', 'break_position']) {
    assert.equal(spot[k]['x-added-in'], '3.3.0', k);
  }
});

test('added enum values are noted in the enum description', () => {
  assert.match(load('enums/demographic-system.json').description, /`nmo` and `videoamp`.*3\.3/);
  const video = load('formats/canonical/video_hosted.json').properties;
  assert.match(video.video_codecs.description, /`mpeg2`, `avc_intra`, and `xavc`.*3\.3/);
  assert.match(video.containers.description, /`mxf`.*3\.3/);
});

test('surfaces shipped in 3.2 are not marked 3.3', () => {
  // placement-evidence and ooh_metrics are in the 3.2 release artifacts.
  assert.equal(load('core/placement-evidence.json')['x-added-in'], '3.2.0');
  assert.equal(load('core/delivery-metrics.json').properties.ooh_metrics['x-added-in'], undefined);
});
