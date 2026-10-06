const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const SCHEMA_ROOT = path.join(ROOT, 'static', 'schemas', 'source');
const VECTOR_ROOT = path.join(ROOT, 'static', 'compliance', 'source', 'test-vectors', 'breakdown-composition');

const REQUEST_URI = '/schemas/media-buy/get-media-buy-delivery-request.json';
const RESPONSE_URI = '/schemas/media-buy/get-media-buy-delivery-response.json';
const CAPABILITIES_URI = '/schemas/core/reporting-capabilities.json';
const COMPOSITION_POINTER = `${RESPONSE_URI}#/properties/media_buy_deliveries/items/properties/by_package/items/allOf/1/properties/by_composition`;
const CAPABILITY_POINTER = `${CAPABILITIES_URI}#/properties/supports_breakdown_composition`;

const ADDITIVE_METRICS = ['impressions', 'spend', 'clicks'];
const DIMENSION_MEMBERS = {
  date: ['date'],
  geo: ['geo_level', 'geo_code'],
  device_type: ['device_type'],
  device_platform: ['device_platform'],
  placement: ['placement_id'],
  creative: ['creative_id'],
  property: ['publisher_domain', 'identifier'],
};
// The marginal by_* array that corresponds to a composed dimension, and the row field that identifies a value.
const MARGINALS = {
  creative: { array: 'by_creative', key: row => row.creative_id, composed: key => key.creative_id },
  geo: { array: 'by_geo', key: row => `${row.geo_level}:${row.geo_code}`, composed: key => `${key.geo_level}:${key.geo_code}` },
  device_type: { array: 'by_device_type', key: row => row.device_type, composed: key => key.device_type },
  device_platform: { array: 'by_device_platform', key: row => row.device_platform, composed: key => key.device_platform },
  placement: { array: 'by_placement', key: row => row.placement_id, composed: key => key.placement_id },
  property: {
    array: 'by_property',
    key: row => `${row.publisher_domain}:${JSON.stringify(row.identifier)}`,
    composed: key => `${key.publisher_domain}:${JSON.stringify(key.identifier)}`,
  },
};

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

function readJson(...segments) {
  return JSON.parse(fs.readFileSync(path.join(...segments), 'utf8'));
}

function loadVectors(directory) {
  const absolute = path.join(VECTOR_ROOT, directory);
  return fs.readdirSync(absolute).filter(name => name.endsWith('.json')).sort()
    .map(name => ({ name, ...readJson(absolute, name) }));
}

async function compile(uriOrSchema) {
  const ajv = new Ajv({ allErrors: true, strict: false, loadSchema: async ref => readSchema(ref) });
  addFormats(ajv);
  const schema = typeof uriOrSchema === 'string' ? { $ref: uriOrSchema } : uriOrSchema;
  // Pointer targets live inside a schema that must be registered by $id first.
  const base = typeof uriOrSchema === 'string' ? uriOrSchema.split('#')[0] : undefined;
  if (base) ajv.addSchema(readSchema(base), base);
  return ajv.compileAsync(schema);
}

// Seller-side rejection rules from the get_media_buy_delivery "Composed breakdowns" contract.
function rejection({ request, capability, product_date_range_support: dateSupport, declared_geo_levels: geoLevels }) {
  if (!capability) return 'BREAKDOWN_COMPOSITION_UNSUPPORTED';
  const { dimensions, geo } = request.breakdown_composition;
  if (dimensions.length > capability.max_dimensions) return 'BREAKDOWN_DIMENSION_NOT_COMPOSABLE';
  for (const dimension of dimensions) {
    if (!capability.composable_dimensions.includes(dimension)) return 'BREAKDOWN_DIMENSION_NOT_COMPOSABLE';
  }
  // A lifetime_only product never lists date, so a conformant capability cannot reach this branch.
  assert.ok(!(dateSupport === 'lifetime_only' && capability.composable_dimensions.includes('date')), 'lifetime_only products MUST NOT list date');
  if (geo && geoLevels && !geoLevels.includes(geo.geo_level)) return 'BREAKDOWN_DIMENSION_NOT_COMPOSABLE';
  return undefined;
}

function sumMetrics(items) {
  return Object.fromEntries(ADDITIVE_METRICS.map(metric => [
    metric,
    Math.round(items.reduce((sum, item) => sum + (item.metrics ? item.metrics[metric] : item[metric]) * 1000, 0)) / 1000,
  ]));
}

// 'not_applicable' when the consistency rule is waived, otherwise whether every sum reconciles.
function marginalsReconcile(vector) {
  const pages = vector.pages ?? [vector.by_package.by_composition];
  const marginals = vector.marginals ?? vector.by_package;
  const last = pages[pages.length - 1];
  if (last.truncated || pages.some(page => page.suppressed)) return 'not_applicable';
  const composition = { dimensions: last.dimensions, rows: pages.flatMap(page => page.rows) };
  const totals = sumMetrics(composition.rows);
  for (const metric of ADDITIVE_METRICS) {
    if (Math.abs(totals[metric] - vector.package_totals[metric]) > 1e-6) return false;
  }
  for (const dimension of composition.dimensions) {
    const marginal = MARGINALS[dimension];
    if (!marginal || !marginals[marginal.array] || marginals[`${marginal.array}_truncated`] !== false) continue;
    const groups = new Map();
    for (const row of composition.rows) {
      const key = marginal.composed(row.key);
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    for (const row of marginals[marginal.array]) {
      const composed = sumMetrics(groups.get(marginal.key(row)) ?? []);
      for (const metric of ADDITIVE_METRICS) {
        if (Math.abs(composed[metric] - row[metric]) > 1e-6) return false;
      }
    }
  }
  return true;
}

describe('breakdown composition contract', () => {
  let validateRequest;
  let validateComposition;
  let validateCapability;

  before(async () => {
    validateRequest = await compile(REQUEST_URI);
    validateComposition = await compile(COMPOSITION_POINTER);
    validateCapability = await compile(CAPABILITY_POINTER);
  });

  describe('positive vectors', () => {
    for (const vector of loadVectors('positive')) {
      it(vector.name, () => {
        if (vector.request) {
          assert.equal(validateRequest(vector.request), vector.expected.schema_valid, JSON.stringify(validateRequest.errors));
          assert.equal(validateCapability(vector.capability), true, JSON.stringify(validateCapability.errors));
          assert.equal(rejection(vector), undefined);
          return;
        }
        for (const page of vector.pages ?? [vector.by_package.by_composition]) {
          assert.equal(validateComposition(page), vector.expected.schema_valid, JSON.stringify(validateComposition.errors));
        }
        assert.equal(marginalsReconcile(vector), vector.expected.marginals_reconcile);
      });
    }
  });

  describe('negative vectors', () => {
    for (const vector of loadVectors('negative')) {
      it(vector.name, () => {
        const outcome = vector.expected_outcome;
        if (outcome.success === false) {
          assert.equal(validateRequest(vector.request), true, JSON.stringify(validateRequest.errors));
          if (vector.capability) assert.equal(validateCapability(vector.capability), true, JSON.stringify(validateCapability.errors));
          assert.equal(rejection(vector), outcome.error_code);
          return;
        }
        if (outcome.target === 'request') {
          assert.equal(validateRequest(vector.request), false);
          return;
        }
        for (const page of vector.pages ?? [vector.by_package.by_composition]) {
          assert.equal(validateComposition(page), outcome.schema_valid, JSON.stringify(validateComposition.errors));
        }
        if ('marginals_reconcile' in outcome) assert.equal(marginalsReconcile(vector), outcome.marginals_reconcile);
      });
    }
  });

  describe('schema shape', () => {
    it('is additive: an existing request still validates and composition is optional', () => {
      const request = readSchema(REQUEST_URI);
      assert.equal(validateRequest({ media_buy_ids: ['mb_1'], reporting_dimensions: { geo: { geo_level: 'region' } } }), true);
      assert.ok(request.properties.breakdown_composition);
      assert.ok(!(request.required ?? []).includes('breakdown_composition'));
    });

    it('is mutually exclusive with reporting_revision_id like the other selectors', () => {
      assert.equal(validateRequest({
        reporting_revision_id: 'rev_1',
        breakdown_composition: { dimensions: ['creative', 'date'] },
      }), false);
    });

    it('requires between 2 and 3 unique dimensions', () => {
      assert.equal(validateRequest({ breakdown_composition: { dimensions: ['creative'] } }), false);
      assert.equal(validateRequest({ breakdown_composition: { dimensions: ['creative', 'creative'] } }), false);
      assert.equal(validateRequest({ breakdown_composition: { dimensions: ['creative', 'date'] } }), true);
    });

    it('defers audience, keyword, and catalog_item', () => {
      for (const dimension of ['audience', 'keyword', 'catalog_item']) {
        assert.equal(validateRequest({ breakdown_composition: { dimensions: [dimension, 'date'] } }), false, dimension);
      }
    });

    it('requires a metro system for metro geo and forbids it otherwise', () => {
      assert.equal(validateRequest({ breakdown_composition: { dimensions: ['geo', 'date'], geo: { geo_level: 'metro', system: 'nielsen_dma' } } }), true);
      assert.equal(validateRequest({ breakdown_composition: { dimensions: ['geo', 'date'], geo: { geo_level: 'metro' } } }), false);
      assert.equal(validateRequest({ breakdown_composition: { dimensions: ['geo', 'date'], geo: { geo_level: 'region', system: 'nielsen_dma' } } }), false);
    });

    it('sorts by the shared sort-metric enum and sort-direction enum', () => {
      const properties = readSchema(REQUEST_URI).properties.breakdown_composition.properties;
      assert.equal(properties.sort_by.$ref, '/schemas/enums/sort-metric.json');
      assert.equal(properties.sort_direction.$ref, '/schemas/enums/sort-direction.json');
      assert.equal(validateRequest({ breakdown_composition: { dimensions: ['creative', 'date'], sort_by: 'impressions_desc' } }), false);
      assert.equal(validateRequest({ breakdown_composition: { dimensions: ['creative', 'date'], sort_by: 'viewable_rate' } }), true);
    });

    it('reuses the shared pagination-response shape and echoes the applied sort', () => {
      const composition = readSchema(RESPONSE_URI)
        .properties.media_buy_deliveries.items.properties.by_package.items.allOf[1].properties.by_composition;
      assert.equal(composition.properties.pagination.$ref, '/schemas/core/pagination-response.json');
      assert.equal(composition.properties.sorted_by.$ref, '/schemas/enums/sort-metric.json');
      assert.equal(composition.properties.sort_direction.$ref, '/schemas/enums/sort-direction.json');
      for (const field of ['dimensions', 'rows', 'truncated', 'suppressed', 'sorted_by', 'sort_direction']) {
        assert.ok(composition.required.includes(field), field);
      }
    });

    it('keys rows with the identity fields of the matching by_* rows', () => {
      const composition = readSchema(RESPONSE_URI)
        .properties.media_buy_deliveries.items.properties.by_package.items.allOf[1].properties.by_composition;
      const keyProperties = Object.keys(composition.properties.rows.items.properties.key.properties).sort();
      const expected = [...new Set(Object.values(DIMENSION_MEMBERS).flat()), 'system'].sort();
      assert.deepEqual(keyProperties, expected);
      assert.equal(composition.properties.rows.items.properties.key.additionalProperties, false);
    });

    it('declares capability with a protocol cap of 3 dimensions, listing date like any other', () => {
      assert.equal(validateCapability({ max_dimensions: 3, composable_dimensions: ['geo', 'creative'] }), true);
      assert.equal(validateCapability({ max_dimensions: 3, composable_dimensions: ['date', 'creative'] }), true);
      assert.equal(validateCapability({ max_dimensions: 4, composable_dimensions: ['geo', 'creative'] }), false);
      assert.equal(validateCapability({ max_dimensions: 1, composable_dimensions: ['geo'] }), false);
      assert.equal(validateCapability({ max_dimensions: 2, composable_dimensions: ['creative'] }), false);
      assert.equal(validateCapability({ max_dimensions: 2, composable_dimensions: ['audience', 'creative'] }), false);
      assert.equal(validateCapability({ max_dimensions: 2, composable_dimensions: [] }), false);
      const capabilities = readSchema(CAPABILITIES_URI);
      assert.ok(!capabilities.required.includes('supports_breakdown_composition'));
    });

    it('is marked experimental on every new surface', () => {
      const composition = readSchema(RESPONSE_URI)
        .properties.media_buy_deliveries.items.properties.by_package.items.allOf[1].properties.by_composition;
      assert.equal(readSchema(REQUEST_URI).properties.breakdown_composition['x-status'], 'experimental');
      assert.equal(composition['x-status'], 'experimental');
      assert.equal(readSchema(CAPABILITIES_URI).properties.supports_breakdown_composition['x-status'], 'experimental');
      const docs = fs.readFileSync(path.join(ROOT, 'docs/reference/experimental-status.mdx'), 'utf8');
      assert.match(docs, /\| `media_buy\.delivery_composition` \|/);
    });

    it('ships both error codes on enumDescriptions and enumMetadata in SCREAMING_SNAKE_CASE', () => {
      const errorCodes = readSchema('/schemas/enums/error-code.json');
      for (const code of ['BREAKDOWN_COMPOSITION_UNSUPPORTED', 'BREAKDOWN_DIMENSION_NOT_COMPOSABLE']) {
        assert.match(code, /^[A-Z][A-Z0-9_]+$/);
        assert.ok(errorCodes.enum.includes(code), `${code} in enum`);
        assert.ok(errorCodes.enumDescriptions[code], `${code} enumDescriptions`);
        assert.equal(errorCodes.enumMetadata[code].recovery, 'correctable', `${code} enumMetadata`);
        assert.match(errorCodes.enumDescriptions[code], /Recovery: correctable/);
      }
    });
  });
});
