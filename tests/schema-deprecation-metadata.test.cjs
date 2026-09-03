#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SOURCE_DIR = path.join(__dirname, '../static/schemas/source');

function findJsonFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return findJsonFiles(fullPath);
    return entry.name.endsWith('.json') ? [fullPath] : [];
  });
}

function walk(value, pointer, visit) {
  if (value === null || typeof value !== 'object') return;
  visit(value, pointer);
  for (const [key, child] of Object.entries(value)) {
    const escaped = key.replaceAll('~', '~0').replaceAll('/', '~1');
    walk(child, `${pointer}/${escaped}`, visit);
  }
}

function explicitlyDeclaresDeprecation(description) {
  return (
    /^(?:\*\*)?deprecated\b/i.test(description) ||
    /^legacy named-format\b/i.test(description) ||
    /^legacy shorthand\b/i.test(description) ||
    /^legacy alias\b/i.test(description) ||
    /^legacy or provider-specific\b/i.test(description) ||
    /^legacy\b[\s\S]*\b(?:is|are|both are) deprecated\b/i.test(description) ||
    /\. Deprecated(?:\s+in|\s*;|\s*—|\s*:)/i.test(description)
  );
}

test('explicitly deprecated schema nodes carry deprecated: true', () => {
  const missing = [];

  for (const file of findJsonFiles(SOURCE_DIR)) {
    const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
    walk(schema, '', (node, pointer) => {
      // Example payloads are instance data, not schema nodes.
      if (pointer.includes('/examples/')) return;
      if (
        typeof node.description === 'string' &&
        explicitlyDeclaresDeprecation(node.description.trim()) &&
        node.deprecated !== true
      ) {
        missing.push(`${path.relative(SOURCE_DIR, file)}#${pointer || '/'}`);
      }
    });
  }

  assert.deepEqual(missing, [], `Missing deprecated: true annotations:\n${missing.join('\n')}`);
});

test('codegen-facing format-variant titles remain stable', () => {
  const expectations = [
    ['core/product.json', ['anyOf', 0, 'title'], 'Named-format product'],
    ['core/product.json', ['anyOf', 1, 'title'], 'Canonical-format product'],
    ['core/creative-asset.json', ['oneOf', 0, 'title'], 'v1 creative (named-format reference)'],
    ['core/creative-asset.json', ['oneOf', 1, 'title'], 'v2 creative (canonical format kind)'],
    ['core/creative-manifest.json', ['oneOf', 0, 'title'], 'Named-format manifest'],
    ['core/creative-manifest.json', ['oneOf', 1, 'title'], 'Canonical-format manifest'],
    ['creative/list-creatives-response.json', ['properties', 'creatives', 'items', 'oneOf', 0, 'title'], 'Listed creative (named-format reference)'],
    ['creative/list-creatives-response.json', ['properties', 'creatives', 'items', 'oneOf', 1, 'title'], 'Listed creative (canonical format kind)'],
  ];

  for (const [relativePath, segments, expected] of expectations) {
    let value = JSON.parse(fs.readFileSync(path.join(SOURCE_DIR, relativePath), 'utf8'));
    for (const segment of segments) value = value[segment];
    assert.equal(value, expected, `${relativePath}#/${segments.join('/')}`);
  }
});

test('lifecycle status is metadata, not part of generated type names', () => {
  const offenders = [];

  for (const file of findJsonFiles(SOURCE_DIR)) {
    const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
    walk(schema, '', (node, pointer) => {
      if (typeof node.title === 'string' && /(?:deprecated|legacy)/i.test(node.title)) {
        offenders.push(`${path.relative(SOURCE_DIR, file)}#${pointer || '/'}: ${node.title}`);
      }
    });
  }

  assert.deepEqual(offenders, [], `Lifecycle markers belong in metadata, not titles:\n${offenders.join('\n')}`);
});

test('format_ids is deprecated in 3.2 and removed in 4.0 everywhere', () => {
  const offenders = [];

  for (const file of findJsonFiles(SOURCE_DIR)) {
    const schema = JSON.parse(fs.readFileSync(file, 'utf8'));
    walk(schema, '', (node, pointer) => {
      if (pointer.includes('/examples/')) return;
      const formatIds = node.properties?.format_ids;
      if (formatIds === null || typeof formatIds !== 'object') return;

      const description = formatIds.description || '';
      if (
        formatIds.deprecated !== true ||
        !/deprecated in AdCP 3\.2/i.test(description) ||
        !/removed in AdCP 4\.0/i.test(description)
      ) {
        offenders.push(`${path.relative(SOURCE_DIR, file)}#${pointer || '/'}/properties/format_ids`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    `Every format_ids field must be deprecated in 3.2 and scheduled for 4.0 removal:\n${offenders.join('\n')}`,
  );
});

test('delivery reporting deprecates cross-buy totals and report-wide currency', () => {
  const response = JSON.parse(fs.readFileSync(
    path.join(SOURCE_DIR, 'media-buy/get-media-buy-delivery-response.json'),
    'utf8',
  ));
  const webhook = JSON.parse(fs.readFileSync(
    path.join(SOURCE_DIR, 'media-buy/media-buy-delivery-webhook-result.json'),
    'utf8',
  ));

  assert.equal(response.properties.aggregated_totals.deprecated, true);
  assert.equal(response.properties.currency.deprecated, true);
  assert.equal(webhook.properties.currency.deprecated, true);

  const responseMetricValue = response.properties.media_buy_deliveries.items
    .properties.by_package.items.allOf[1].properties.metric_values.items;
  const webhookMetricValue = webhook.properties.media_buy_deliveries.items
    .properties.by_package.items.allOf[1].properties.metric_values.items;
  assert.equal(responseMetricValue.title, 'GetMediaBuyDeliveryPackageMetricValue');
  assert.equal(webhookMetricValue.title, 'MediaBuyDeliveryWebhookPackageMetricValue');
  assert.notEqual(responseMetricValue.title, webhookMetricValue.title);

  for (const schema of [response, webhook]) {
    assert.equal(schema.required.includes('currency'), false);
    const rowCurrency = schema.properties.media_buy_deliveries.items.properties.currency;
    assert.equal(rowCurrency.type, 'string');
    assert.match(rowCurrency.description, /does not perform currency conversion/i);
    assert.match(rowCurrency.description, /mixed-currency buy/i);

    const row = schema.properties.media_buy_deliveries.items;
    assert.equal(row.properties.totals.allOf[1].required?.includes('spend') ?? false, false);
    const packageProperties = row.properties.by_package.items.allOf[1].properties;
    assert.equal(
      packageProperties.metric_values.items.allOf[0].$ref,
      '/schemas/core/delivery-metric-aggregate.json#/oneOf/0',
    );
    assert.match(packageProperties.currency.description, /MUST equal it/);
    assert.match(
      schema['x-adcp-validation'].verifier_constraints.row_currency_consistency,
      /MUST equal/,
    );
    assert.match(
      schema['x-adcp-validation'].verifier_constraints.mixed_currency_row,
      /MUST be omitted/,
    );
    assert.match(
      schema['x-adcp-validation'].verifier_constraints.legacy_currency_consistency,
      /MUST equal/,
    );
  }
});
