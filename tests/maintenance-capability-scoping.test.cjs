#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const YAML = require('yaml');

const sourceRoot = path.join(__dirname, '..', 'static', 'compliance', 'source');
const scenarioRoot = path.join(sourceRoot, 'protocols', 'media-buy', 'scenarios');

function load(file) {
  return YAML.parse(fs.readFileSync(file, 'utf8'));
}

test('3.0 creative-dependent seller scenarios require a creative library', () => {
  for (const name of ['pending_creatives_to_start', 'creative_fate_after_cancellation']) {
    const storyboard = load(path.join(scenarioRoot, `${name}.yaml`));
    assert.deepEqual(storyboard.requires_capability, {
      path: 'creative.has_creative_library',
      equals: true,
    }, name);
  }
});

test('3.0 keeps only universal measurement-term rejection', () => {
  const storyboard = load(path.join(scenarioRoot, 'measurement_terms_rejected.yaml'));
  assert.deepEqual(storyboard.phases.map(phase => phase.id), [
    'discover_products',
    'reject_terms',
  ]);
});

test('3.0 does not make refinement badge-required without a capability field', () => {
  const indexFiles = [
    path.join(sourceRoot, 'protocols', 'media-buy', 'index.yaml'),
    path.join(sourceRoot, 'specialisms', 'sales-guaranteed', 'index.yaml'),
    path.join(sourceRoot, 'specialisms', 'sales-broadcast-tv', 'index.yaml'),
    path.join(sourceRoot, 'specialisms', 'sales-catalog-driven', 'index.yaml'),
    path.join(sourceRoot, 'specialisms', 'creative-generative', 'generative-seller.yaml'),
  ];

  for (const file of indexFiles) {
    const index = load(file);
    assert.ok(
      !index.requires_scenarios.includes('media_buy_seller/refine_products'),
      index.id
    );
  }
});

test('3.0 direct creative-sync phases have authoritative library gates', () => {
  const indexFiles = [
    path.join(sourceRoot, 'protocols', 'media-buy', 'index.yaml'),
    ...['sales-broadcast-tv', 'sales-guaranteed', 'sales-proposal-mode'].map(name =>
      path.join(sourceRoot, 'specialisms', name, 'index.yaml')
    ),
  ];

  for (const file of indexFiles) {
    const index = load(file);
    const phase = index.phases.find(candidate => candidate.id === 'creative_sync');
    assert.deepEqual(phase.requires_capability, {
      path: 'creative.has_creative_library',
      equals: true,
    }, index.id);
  }
});
