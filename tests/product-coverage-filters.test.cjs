const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const YAML = require('yaml');

const root = path.join(__dirname, '..');
const schemaRoot = path.join(root, 'static/schemas/source');
async function compile(name, base = schemaRoot) {
  const loadSchema = async uri => {
    assert.ok(uri.startsWith('/schemas/'), uri);
    let relative = uri.slice('/schemas/'.length);
    const releasePrefix = `${path.basename(base)}/`;
    if (base !== schemaRoot && relative.startsWith(releasePrefix)) relative = relative.slice(releasePrefix.length);
    const file = path.resolve(base, relative);
    assert.ok(file.startsWith(`${base}${path.sep}`), uri);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  };
  const ajv = new Ajv({ strict: false, allErrors: true, loadSchema });
  addFormats(ajv);
  return ajv.compileAsync(await loadSchema(`/schemas/${name}.json`));
}

test('coverage has a native home without adding a delivery overlay', async () => {
  const validate = await compile('media-buy/list-products-request');
  for (const offer_filters of [
    { countries: ['US'], metros: [{ system: 'nielsen_dma', code: '501' }] },
    { regions: ['US-NY', 'FR-2A'] },
    { postal_areas: [{ system: 'us_zip', values: ['10001'] }] },
    { geo_proximity: [{ lat: 40.75, lng: -73.99, radius: { value: 5, unit: 'km' } }] },
    { geo_proximity: [{ lat: 40.75, lng: -73.99, travel_time: { value: 15, unit: 'min' }, transport_mode: 'driving' }] },
    { geo_proximity: [{ geometry: { type: 'Polygon', coordinates: [[[-74, 40], [-73, 40], [-73, 41], [-74, 40]]] } }] },
  ]) {
    const request = { criteria: { offer_filters } };
    assert.equal(validate(request), true, JSON.stringify(validate.errors));
    assert.equal(request.criteria.targeting_overlay, undefined);
  }
  assert.equal(validate({ criteria: {
    offer_filters: { countries: ['CA'] }, targeting_overlay: { geo_countries: ['US'] },
  } }), true, JSON.stringify(validate.errors));
});

test('coverage rejects malformed identifiers and ambiguous proximity methods', async () => {
  const validate = await compile('core/product-offer-filters');
  for (const filters of [
    { regions: ['GB-ABCD'] }, { regions: [] },
    { metros: [{ system: 'nielsen_dma' }] },
    { metros: [{ system: 'nielsen_dma', values: ['501'] }] },
    { geo_proximity: [{ lat: 91, lng: 0, radius: { value: 5, unit: 'km' } }] },
    { geo_proximity: [{ lat: 40, lng: 0, travel_time: { value: 15, unit: 'min' } }] },
    { geo_proximity: [{ lat: 40, lng: 0, radius: { value: 5, unit: 'km' }, geometry: { type: 'Polygon', coordinates: [] } }] },
  ]) assert.equal(validate(filters), false, JSON.stringify(filters));
});

test('the original released 3.1 country/metro request remains valid', async () => {
  const releaseRoot = path.join(root, 'dist/schemas/3.1.19');
  const validate = await compile('media-buy/get-products-request', releaseRoot);
  assert.equal(validate({ buying_mode: 'wholesale', filters: {
    countries: ['US'], metros: [{ system: 'nielsen_dma', code: '501' }],
  } }), true, JSON.stringify(validate.errors));
});

test('both graded discovery requests validate against their own task schema', async () => {
  const storyboard = YAML.parse(fs.readFileSync(path.join(root,
    'static/compliance/source/protocols/media-buy/scenarios/product_coverage_filters.yaml'), 'utf8'));
  for (const step of storyboard.phases.flatMap(phase => phase.steps)) {
    const validate = await compile(step.schema_ref.replace(/\.json$/, ''));
    assert.equal(validate(step.sample_request), true, JSON.stringify(validate.errors));
  }
});
