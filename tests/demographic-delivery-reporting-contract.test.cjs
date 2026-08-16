const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_ROOT = path.join(__dirname, '..', 'static', 'schemas', 'source');

function readSchema(uri) {
  assert.match(uri, /^\/schemas\//);
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, uri.slice('/schemas/'.length)), 'utf8'));
}

async function compile(uri) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: async ref => readSchema(ref),
  });
  addFormats(ajv);
  return ajv.compileAsync(readSchema(uri));
}

test('demographic reporting request accepts limits and sort metrics', async () => {
  const validate = await compile('/schemas/media-buy/get-media-buy-delivery-request.json');

  assert.equal(validate({ reporting_dimensions: { demographic: {} } }), true);
  assert.equal(
    validate({
      reporting_dimensions: {
        demographic: {
          age_ranges: [{ min: 26, max: 30, include_unknown: false }],
          limit: 10,
          sort_by: 'impressions',
        },
      },
    }),
    true,
    JSON.stringify(validate.errors),
  );
  assert.equal(validate({ reporting_dimensions: { demographic: { limit: 0 } } }), false);
  assert.equal(
    validate({ reporting_dimensions: { demographic: { age_ranges: [{ min: 26, max: 30 }] } } }),
    false,
    'requested age ranges require explicit unknown-age handling',
  );
});

test('demographic delivery rows reuse the shared demographic system vocabulary', async () => {
  const response = readSchema('/schemas/media-buy/get-media-buy-delivery-response.json');
  const byPackage = response.properties.media_buy_deliveries.items.properties.by_package.items;
  const extension = byPackage.allOf.find(part => part.properties?.by_demographic);
  assert.ok(extension, 'by_package exposes by_demographic');

  const validate = await compile('/schemas/media-buy/get-media-buy-delivery-response.json');
  const base = {
    status: 'completed',
    reporting_period: {
      start: '2026-08-01T00:00:00Z',
      end: '2026-08-15T23:59:59Z',
    },
    currency: 'USD',
    media_buy_deliveries: [{
      media_buy_id: 'mb_demo',
      buyer_ref: 'buyer_demo',
      status: 'active',
      currency: 'USD',
      total_spend: 14400,
      totals: {
        spend: 14400,
        impressions: 1200000,
      },
      by_package: [{
        package_id: 'pkg_demo',
        spend: 14400,
        impressions: 1200000,
        pricing_model: 'cpm',
        rate: 12,
        currency: 'USD',
        by_demographic: [{
          demographic: 'P25-54',
          demographic_system: 'nielsen',
          age: { min: 25, max: 54, include_unknown: false },
          impressions: 1200000,
          spend: 14400,
        }],
        by_demographic_truncated: false,
        by_demographic_suppressed: false,
      }],
    }],
  };

  assert.equal(validate(base), true, JSON.stringify(validate.errors));

  const unknownSystem = structuredClone(base);
  unknownSystem.media_buy_deliveries[0].by_package[0].by_demographic[0].demographic_system = 'unknown';
  assert.equal(validate(unknownSystem), false, 'unknown demographic systems are rejected');

  const missingCode = structuredClone(base);
  delete missingCode.media_buy_deliveries[0].by_package[0].by_demographic[0].demographic;
  assert.equal(validate(missingCode), false, 'demographic code is required');

  const blankCode = structuredClone(base);
  blankCode.media_buy_deliveries[0].by_package[0].by_demographic[0].demographic = '   ';
  assert.equal(validate(blankCode), false, 'blank demographic codes are rejected');
});

test('reporting capabilities expose demographic breakdown support on both surfaces', () => {
  const legacy = readSchema('/schemas/core/reporting-capabilities.json');
  const canonical = readSchema('/schemas/core/canonical-reporting-capabilities.json');

  assert.equal(
    legacy.properties.supports_demographic_breakdown.$ref,
    '/schemas/core/demographic-reporting-capability.json',
  );
  assert.equal(
    canonical.properties.supports_demographic_breakdown.$ref,
    '/schemas/core/demographic-reporting-capability.json',
  );
});

test('demographic reporting capability separates exact predicates from fixed social-style intervals', async () => {
  const validate = await compile('/schemas/core/reporting-capabilities.json');
  const base = {
    available_reporting_frequencies: ['daily'],
    expected_delay_minutes: 60,
    timezone: 'UTC',
    supports_webhooks: true,
    available_metrics: ['impressions', 'spend'],
    date_range_support: 'date_range',
    supports_demographic_breakdown: {
      age: {
        reporting_modes: ['enumerated_intervals'],
        intervals: [{
          age: { min: 25, max: 34, include_unknown: false },
          demographic: '25-34',
          demographic_system: 'custom',
        }],
      },
      demographic_systems: ['custom'],
      may_suppress_small_cells: true,
    },
  };

  assert.equal(validate(base), true, JSON.stringify(validate.errors));

  const exactWithoutBounds = structuredClone(base);
  exactWithoutBounds.supports_demographic_breakdown.age = {
    reporting_modes: ['exact_predicates'],
  };
  assert.equal(validate(exactWithoutBounds), false, 'exact reporting declares its supported bounds');

  const missingSuppressionPosture = structuredClone(base);
  delete missingSuppressionPosture.supports_demographic_breakdown.may_suppress_small_cells;
  assert.equal(validate(missingSuppressionPosture), false, 'suppression posture is explicit');
});
