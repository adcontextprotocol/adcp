#!/usr/bin/env node
/**
 * Buyer storyboards declare the products a fixture publisher serves. The
 * fixture-publisher contract returns the same product set from get_products
 * and list_products, so every declared product must validate as both the
 * legacy Product (core/product.json) and the compact canonical Product
 * (core/canonical-product.json). A product valid under only one shape sends
 * a conformant buyer a response that fails its schema on the other tool.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');
const Ajv = require('ajv').default;
const addFormats = require('ajv-formats').default;

const SCHEMAS_DIR = path.join(__dirname, '..', 'static', 'schemas', 'source');
const SOURCE_ROOT = path.join(__dirname, '..', 'static', 'compliance', 'source');
const PRODUCT_SCHEMAS = ['/schemas/core/product.json', '/schemas/core/canonical-product.json'];

function buildAjv() {
  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.json')) continue;
      const schema = JSON.parse(fs.readFileSync(full, 'utf8'));
      if (!schema.$id) continue;
      try {
        ajv.addSchema(schema, schema.$id);
      } catch (e) {
        if (!/already exists/.test(e.message)) throw e;
      }
    }
  })(SCHEMAS_DIR);
  return ajv;
}

function yamlFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...yamlFiles(full));
    else if (entry.name.endsWith('.yaml')) out.push(full);
  }
  return out;
}

function fixtureProducts(file) {
  const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
  const products = doc?.fixtures?.fixture_publisher?.products;
  return Array.isArray(products) ? products : [];
}

function productErrors(ajv, product) {
  const errors = [];
  for (const id of PRODUCT_SCHEMAS) {
    const validate = ajv.getSchema(id);
    assert.ok(validate, `${id} is not loaded`);
    if (validate(product)) continue;
    for (const e of validate.errors) {
      const detail = e.params?.additionalProperty ?? e.params?.missingProperty;
      errors.push(`${id} ${e.instancePath || '/'} ${e.message}${detail ? `: ${detail}` : ''}`);
    }
  }
  return errors;
}

const ajv = buildAjv();

test('every buyer fixture product validates as both legacy and canonical Product', () => {
  const failures = [];
  let checked = 0;
  for (const file of yamlFiles(SOURCE_ROOT)) {
    for (const product of fixtureProducts(file)) {
      checked += 1;
      for (const error of productErrors(ajv, product)) {
        failures.push(`${path.relative(SOURCE_ROOT, file)} ${product.product_id}: ${error}`);
      }
    }
  }
  assert.ok(checked > 0, 'no fixture_publisher products found; the source walk is broken');
  assert.deepEqual(failures, []);
});

test('a product valid under only one shape is rejected', () => {
  const dualShape = {
    product_id: 'p',
    name: 'P',
    description: 'd',
    publisher_properties: [{ publisher_domain: 'pub.example', selection_type: 'all' }],
    format_options: [{ format_option_id: 'f', format_kind: 'image', params: { width: 300, height: 250 } }],
    delivery_type: 'non_guaranteed',
    pricing_options: [{ pricing_option_id: 'po', pricing_model: 'cpm', currency: 'USD', floor_price: 1 }],
    reporting_capabilities: {
      available_reporting_frequencies: ['daily'],
      expected_delay_minutes: 60,
      timezone: 'UTC',
      supports_webhooks: false,
      available_metrics: ['impressions'],
      date_range_support: 'date_range',
    },
  };
  assert.deepEqual(productErrors(ajv, dualShape), []);
  const errors = productErrors(ajv, { ...dualShape, installments: [] });
  assert.ok(errors.some((e) => e.startsWith('/schemas/core/canonical-product.json') && e.includes('installments')), errors.join('\n'));
  const missing = productErrors(ajv, { product_id: 'p', name: 'P' });
  assert.ok(missing.some((e) => e.startsWith('/schemas/core/product.json')), missing.join('\n'));
});
