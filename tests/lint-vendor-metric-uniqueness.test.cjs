#!/usr/bin/env node
/**
 * Tests for scripts/lint-vendor-metric-uniqueness.cjs
 *
 * Validates that the lint correctly identifies duplicate
 * (vendor.domain, vendor.brand_id, metric_id) tuples in storyboard
 * fixture payloads (sample_request and params), and that it passes
 * when tuples are distinct.
 *
 * adcontextprotocol/adcp#3502
 */

'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { findDuplicatesInPayload, vendorMetricKey } = require('../scripts/lint-vendor-metric-uniqueness.cjs');

// ── vendorMetricKey ───────────────────────────────────────────────────────────

test('vendorMetricKey: builds correct key from full BrandRef', () => {
  const entry = { vendor: { domain: 'acme.example', brand_id: 'spark' }, metric_id: 'attention_units' };
  assert.equal(vendorMetricKey(entry), 'acme.example|spark|attention_units');
});

test('vendorMetricKey: absent brand_id normalizes to empty string', () => {
  const entry = { vendor: { domain: 'acme.example' }, metric_id: 'gco2e_per_impression' };
  assert.equal(vendorMetricKey(entry), 'acme.example||gco2e_per_impression');
});

test('vendorMetricKey: {domain:"x"} and {domain:"x",brand_id:""} produce different keys from {domain:"x",brand_id:"sub"}', () => {
  const noId  = vendorMetricKey({ vendor: { domain: 'x.example' }, metric_id: 'm' });
  const emptyId = vendorMetricKey({ vendor: { domain: 'x.example', brand_id: '' }, metric_id: 'm' });
  const subId = vendorMetricKey({ vendor: { domain: 'x.example', brand_id: 'sub' }, metric_id: 'm' });
  // Both absent and explicit-empty stringify to the same normalized form.
  assert.equal(noId, emptyId);
  assert.notEqual(noId, subId);
});

test('vendorMetricKey: returns null for entry without vendor', () => {
  assert.equal(vendorMetricKey({ metric_id: 'foo' }), null);
  assert.equal(vendorMetricKey(null), null);
  assert.equal(vendorMetricKey({}), null);
});

// ── findDuplicatesInPayload ───────────────────────────────────────────────────

test('findDuplicatesInPayload: returns empty for null/non-object', () => {
  assert.deepEqual(findDuplicatesInPayload(null), []);
  assert.deepEqual(findDuplicatesInPayload('string'), []);
  assert.deepEqual(findDuplicatesInPayload(42), []);
});

test('findDuplicatesInPayload: no duplicates — distinct vendors', () => {
  const payload = {
    vendor_metric_values: [
      { vendor: { domain: 'vendor-a.example' }, metric_id: 'attention_units', value: 4.2 },
      { vendor: { domain: 'vendor-b.example' }, metric_id: 'attention_units', value: 3.1 },
    ],
  };
  assert.deepEqual(findDuplicatesInPayload(payload), []);
});

test('findDuplicatesInPayload: no duplicates — same vendor, different metric_id', () => {
  const payload = {
    vendor_metric_values: [
      { vendor: { domain: 'vendor-a.example' }, metric_id: 'attention_units', value: 4.2 },
      { vendor: { domain: 'vendor-a.example' }, metric_id: 'gco2e_per_impression', value: 0.85 },
    ],
  };
  assert.deepEqual(findDuplicatesInPayload(payload), []);
});

test('findDuplicatesInPayload: no duplicates — same domain, different brand_id', () => {
  const payload = {
    vendor_metric_values: [
      { vendor: { domain: 'house.example', brand_id: 'brand_a' }, metric_id: 'lift', value: 1.1 },
      { vendor: { domain: 'house.example', brand_id: 'brand_b' }, metric_id: 'lift', value: 1.2 },
    ],
  };
  assert.deepEqual(findDuplicatesInPayload(payload), []);
});

test('findDuplicatesInPayload: detects duplicate vendor_metric_values', () => {
  const payload = {
    vendor_metric_values: [
      { vendor: { domain: 'vendor-a.example' }, metric_id: 'attention_units', value: 4.2 },
      { vendor: { domain: 'vendor-a.example' }, metric_id: 'attention_units', value: 4.5 },
    ],
  };
  const result = findDuplicatesInPayload(payload);
  assert.equal(result.length, 1);
  assert.ok(result[0].includes('vendor_metric_values'));
  assert.ok(result[0].includes('vendor-a.example||attention_units'));
});

test('findDuplicatesInPayload: detects duplicate vendor_metrics declarations', () => {
  const payload = {
    vendor_metrics: [
      { vendor: { domain: 'vendor-a.example' }, metric_id: 'reach' },
      { vendor: { domain: 'vendor-a.example' }, metric_id: 'reach' },
    ],
  };
  const result = findDuplicatesInPayload(payload);
  assert.equal(result.length, 1);
  assert.ok(result[0].includes('vendor_metrics'));
});

test('findDuplicatesInPayload: brand_id absent vs present are not duplicates', () => {
  const payload = {
    vendor_metric_values: [
      { vendor: { domain: 'house.example' }, metric_id: 'lift', value: 1.1 },
      { vendor: { domain: 'house.example', brand_id: 'tide' }, metric_id: 'lift', value: 1.2 },
    ],
  };
  assert.deepEqual(findDuplicatesInPayload(payload), []);
});

test('findDuplicatesInPayload: skips entries with no vendor field', () => {
  const payload = {
    vendor_metric_values: [
      { metric_id: 'attention_units', value: 4.2 },
      { metric_id: 'attention_units', value: 4.5 },
    ],
  };
  // Both entries lack `vendor` — vendorMetricKey returns null — should not be flagged.
  assert.deepEqual(findDuplicatesInPayload(payload), []);
});

test('findDuplicatesInPayload: only one entry — no possible duplicate', () => {
  const payload = {
    vendor_metric_values: [
      { vendor: { domain: 'vendor-a.example' }, metric_id: 'attention_units', value: 4.2 },
    ],
  };
  assert.deepEqual(findDuplicatesInPayload(payload), []);
});

test('findDuplicatesInPayload: empty arrays produce no violations', () => {
  assert.deepEqual(findDuplicatesInPayload({ vendor_metric_values: [] }), []);
  assert.deepEqual(findDuplicatesInPayload({ vendor_metrics: [] }), []);
});
