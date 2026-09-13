#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..');

function readSchema(relativePath) {
  return JSON.parse(
    fs.readFileSync(path.join(ROOT, 'static', 'schemas', 'source', relativePath), 'utf8'),
  );
}

function canonicalAssetTypes() {
  const assetUnion = readSchema('core/assets/asset-union.json');
  return assetUnion.oneOf.map(({ $ref }) =>
    path.basename($ref, '-asset.json').replaceAll('-', '_'),
  );
}

function declaredAssetTypes(branches) {
  return branches.map((branch) => branch.properties.asset_type.const);
}

test('legacy format asset declarations stay aligned with the canonical asset union', () => {
  const format = readSchema('core/format.json');
  const formatAssets = format.properties.assets.items.oneOf;
  const individualTypes = declaredAssetTypes(formatAssets[0].oneOf);
  const groupTypes = declaredAssetTypes(
    formatAssets[1].properties.assets.items.oneOf,
  );
  const canonicalTypes = canonicalAssetTypes();

  assert.deepEqual(
    [...individualTypes].sort(),
    [...canonicalTypes].sort(),
    'individual format assets drifted from core/assets/asset-union.json',
  );
  assert.deepEqual(
    [...groupTypes].sort(),
    [...canonicalTypes].sort(),
    'repeatable-group format assets drifted from core/assets/asset-union.json',
  );
});
