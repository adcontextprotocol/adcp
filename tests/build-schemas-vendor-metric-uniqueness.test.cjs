#!/usr/bin/env node
/**
 * Unit tests for collectVendorMetricExamples / lintVendorMetricSemanticUniqueness
 * in scripts/build-schemas.cjs.
 *
 * These functions enforce the semantic uniqueness key
 * `(vendor.domain, vendor.brand_id, metric_id)` documented on the
 * `vendor_metrics` array (reporting-capabilities.json) and the
 * `vendor_metric_values` array (delivery-metrics.json). JSON Schema
 * `uniqueItems` is deliberately not used there because BrandRef carries
 * optional fields whose absence/presence defeats deep-equal — see the
 * schema descriptions and scripts/build-schemas.cjs for the full rationale.
 *
 * Landed in #3512 without the isolated-unit-test treatment given to sibling
 * build-schemas lint/hoist helpers (tests/build-schemas-hoist-marked.test.cjs,
 * tests/build-schemas-hoist-enums.test.cjs, tests/build-schemas-async-response-refs.test.cjs):
 * those exercise their function directly against constructed fixtures, so a
 * regression is caught by a fast `node --test` run rather than only surfacing
 * when `npm run build:schemas` happens to walk a schema file with a duplicate
 * tuple. This file closes that gap. Issue: adcontextprotocol/adcp#3502.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  collectVendorMetricExamples,
  lintVendorMetricSemanticUniqueness,
} = require('../scripts/build-schemas.cjs');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function vendorMetric(domain, brandId, metricId) {
  const vendor = brandId === undefined ? { domain } : { domain, brand_id: brandId };
  return { vendor, metric_id: metricId };
}

// ── collectVendorMetricExamples: pure-function detection logic ────────────

test('collectVendorMetricExamples: no violation for distinct (domain, brand_id, metric_id) tuples', () => {
  const schema = {
    examples: [
      {
        vendor_metrics: [
          vendorMetric('scope3.com', undefined, 'gco2e_per_impression'),
          vendorMetric('scope3.com', 'brand-a', 'gco2e_per_impression'),
          vendorMetric('adelaide.com', undefined, 'attention_units'),
        ],
      },
    ],
  };
  const out = collectVendorMetricExamples(schema, 'core/reporting-capabilities.json');
  assert.equal(out.length, 1);
  const seen = new Set();
  const duplicates = out[0].tuples.filter(t => (seen.has(t) ? true : (seen.add(t), false)));
  assert.deepEqual(duplicates, []);
});

test('collectVendorMetricExamples: detects a duplicate vendor_metrics tuple', () => {
  const schema = {
    examples: [
      {
        vendor_metrics: [
          vendorMetric('scope3.com', undefined, 'gco2e_per_impression'),
          vendorMetric('scope3.com', undefined, 'gco2e_per_impression'),
        ],
      },
    ],
  };
  const out = collectVendorMetricExamples(schema, 'core/reporting-capabilities.json');
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].tuples, [
    'scope3.com||gco2e_per_impression',
    'scope3.com||gco2e_per_impression',
  ]);
});

test('collectVendorMetricExamples: detects a duplicate vendor_metric_values tuple', () => {
  const schema = {
    examples: [
      {
        vendor_metric_values: [
          vendorMetric('adelaide.com', 'sub-brand', 'attention_units'),
          vendorMetric('adelaide.com', 'sub-brand', 'attention_units'),
        ],
      },
    ],
  };
  const out = collectVendorMetricExamples(schema, 'core/delivery-metrics.json');
  assert.equal(out.length, 1);
  assert.equal(out[0].arrayField, 'vendor_metric_values');
});

test('collectVendorMetricExamples: recurses into nested examples at any depth', () => {
  const schema = {
    properties: {
      reporting_capabilities: {
        examples: [
          {
            vendor_metrics: [
              vendorMetric('scope3.com', undefined, 'x'),
              vendorMetric('scope3.com', undefined, 'x'),
            ],
          },
        ],
      },
    },
  };
  const out = collectVendorMetricExamples(schema, 'core/product.json');
  assert.equal(out.length, 1);
  assert.equal(out[0].tuples.length, 2);
});

test('collectVendorMetricExamples: skips arrays with fewer than 2 entries', () => {
  const schema = { examples: [{ vendor_metrics: [vendorMetric('scope3.com', undefined, 'x')] }] };
  const out = collectVendorMetricExamples(schema, 'core/reporting-capabilities.json');
  assert.deepEqual(out, []);
});

test('collectVendorMetricExamples: ignores unrelated fields and non-object input', () => {
  assert.deepEqual(collectVendorMetricExamples(null, 'x.json'), []);
  assert.deepEqual(collectVendorMetricExamples('a string', 'x.json'), []);
  const out = collectVendorMetricExamples({ examples: [{ other_field: [1, 2, 3] }] }, 'x.json');
  assert.deepEqual(out, []);
});

// ── lintVendorMetricSemanticUniqueness: filesystem-walking build-time check ──

test('lintVendorMetricSemanticUniqueness: passes silently over a clean schema tree', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-vendor-metric-uniqueness-'));
  try {
    writeJson(path.join(tmpRoot, 'core', 'reporting-capabilities.json'), {
      title: 'Reporting Capabilities',
      examples: [
        {
          vendor_metrics: [
            vendorMetric('scope3.com', undefined, 'gco2e_per_impression'),
            vendorMetric('adelaide.com', undefined, 'attention_units'),
          ],
        },
      ],
    });
    assert.doesNotThrow(() => lintVendorMetricSemanticUniqueness(tmpRoot));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('lintVendorMetricSemanticUniqueness: fails the build on a duplicate (vendor, metric_id) tuple', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-vendor-metric-uniqueness-'));
  try {
    writeJson(path.join(tmpRoot, 'core', 'delivery-metrics.json'), {
      title: 'Delivery Metrics',
      examples: [
        {
          vendor_metric_values: [
            vendorMetric('scope3.com', undefined, 'gco2e_per_impression'),
            vendorMetric('scope3.com', undefined, 'gco2e_per_impression'),
          ],
        },
      ],
    });
    assert.throws(
      () => lintVendorMetricSemanticUniqueness(tmpRoot),
      /duplicate tuple "scope3\.com\|\|gco2e_per_impression"/
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('lintVendorMetricSemanticUniqueness: error message names the schema file and array field', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-vendor-metric-uniqueness-'));
  try {
    writeJson(path.join(tmpRoot, 'core', 'reporting-capabilities.json'), {
      title: 'Reporting Capabilities',
      examples: [
        {
          vendor_metrics: [
            vendorMetric('adelaide.com', 'sub-brand', 'attention_units'),
            vendorMetric('adelaide.com', 'sub-brand', 'attention_units'),
          ],
        },
      ],
    });
    assert.throws(() => lintVendorMetricSemanticUniqueness(tmpRoot), (err) => {
      assert.match(err.message, /core[/\\]reporting-capabilities\.json/);
      assert.match(err.message, /vendor_metrics: duplicate tuple/);
      assert.match(err.message, /adcontextprotocol\/adcp#3502/);
      return true;
    });
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('lintVendorMetricSemanticUniqueness: de-duplicating the fixture clears the violation', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-vendor-metric-uniqueness-'));
  try {
    const dupe = {
      title: 'Delivery Metrics',
      examples: [
        {
          vendor_metric_values: [
            vendorMetric('scope3.com', undefined, 'gco2e_per_impression'),
            vendorMetric('scope3.com', undefined, 'gco2e_per_impression'),
          ],
        },
      ],
    };
    writeJson(path.join(tmpRoot, 'core', 'delivery-metrics.json'), dupe);
    assert.throws(() => lintVendorMetricSemanticUniqueness(tmpRoot));

    // The seller-side fix: de-duplicate before emission (per the schema's
    // normative MUST). A distinct metric_id is no longer a collision.
    const fixed = JSON.parse(JSON.stringify(dupe));
    fixed.examples[0].vendor_metric_values[1].metric_id = 'other_metric';
    writeJson(path.join(tmpRoot, 'core', 'delivery-metrics.json'), fixed);
    assert.doesNotThrow(() => lintVendorMetricSemanticUniqueness(tmpRoot));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('lintVendorMetricSemanticUniqueness: reports one violation per duplicate array, across multiple files', () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-vendor-metric-uniqueness-'));
  try {
    writeJson(path.join(tmpRoot, 'core', 'reporting-capabilities.json'), {
      examples: [{
        vendor_metrics: [
          vendorMetric('scope3.com', undefined, 'x'),
          vendorMetric('scope3.com', undefined, 'x'),
        ],
      }],
    });
    writeJson(path.join(tmpRoot, 'core', 'delivery-metrics.json'), {
      examples: [{
        vendor_metric_values: [
          vendorMetric('adelaide.com', undefined, 'y'),
          vendorMetric('adelaide.com', undefined, 'y'),
        ],
      }],
    });
    assert.throws(
      () => lintVendorMetricSemanticUniqueness(tmpRoot),
      /2 duplicate tuple\(s\) found/
    );
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
