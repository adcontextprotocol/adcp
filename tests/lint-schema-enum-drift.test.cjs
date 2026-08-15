#!/usr/bin/env node

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { lint, loadCanonicalEnums, ALLOWED } = require('../scripts/lint-schema-enum-drift.cjs');

test('source tree has no inline-enum drift violations', () => {
  const { driftViolations } = lint();
  assert.deepEqual(
    driftViolations,
    [],
    'inline enums have drifted from their canonical enum files:\n' +
      driftViolations
        .map(
          (v) =>
            `  ${v.file}${v.path} — missing: ${v.missing.join(', ')} (canonical: enums/${v.canonicalEnum})`,
        )
        .join('\n'),
  );
});

test('canonical enums load from enums/ directory', () => {
  const enums = loadCanonicalEnums();
  assert.ok(enums.size > 0, 'expected at least one canonical enum file');
  assert.ok(enums.has('property-type.json'), 'expected property-type.json in canonical enums');
  assert.ok(enums.has('account-status.json'), 'expected account-status.json in canonical enums');
});

test('capabilities trusted_match.surfaces uses $ref to property-type.json', () => {
  const capFile = path.resolve(
    __dirname,
    '..',
    'static',
    'schemas',
    'source',
    'protocol',
    'get-adcp-capabilities-response.json',
  );
  const doc = JSON.parse(fs.readFileSync(capFile, 'utf8'));
  const surfaces =
    doc.properties.media_buy.properties.execution.properties.trusted_match.properties.surfaces
      .items;
  assert.ok(surfaces.$ref, 'trusted_match.surfaces.items should use $ref, not inline enum');
  assert.ok(
    surfaces.$ref.includes('property-type'),
    'trusted_match.surfaces should reference property-type.json',
  );
});

test('registry-event badgeRole uses $ref to adcp-protocol.json', () => {
  const regFile = path.resolve(
    __dirname,
    '..',
    'static',
    'schemas',
    'source',
    'core',
    'registry-event.json',
  );
  const doc = JSON.parse(fs.readFileSync(regFile, 'utf8'));
  const badgeRole = doc.$defs.badgeRole;
  assert.ok(badgeRole.$ref, 'badgeRole should use $ref, not inline enum');
  assert.ok(
    badgeRole.$ref.includes('adcp-protocol'),
    'badgeRole should reference adcp-protocol.json',
  );
});

test('sponsored_placement supported_catalog_types uses $ref to catalog-type.json', () => {
  const spFile = path.resolve(
    __dirname,
    '..',
    'static',
    'schemas',
    'source',
    'formats',
    'canonical',
    'sponsored_placement.json',
  );
  const doc = JSON.parse(fs.readFileSync(spFile, 'utf8'));
  const items = doc.properties.supported_catalog_types.items;
  assert.ok(items.$ref, 'supported_catalog_types.items should use $ref, not inline enum');
  assert.ok(
    items.$ref.includes('catalog-type'),
    'supported_catalog_types should reference catalog-type.json',
  );
});

test('allowlist entries reference files that exist', () => {
  const schemaDir = path.resolve(__dirname, '..', 'static', 'schemas', 'source');
  for (const entry of ALLOWED) {
    const file = entry.split('|')[0];
    const absPath = path.join(schemaDir, file);
    assert.ok(fs.existsSync(absPath), `allowlist entry references non-existent file: ${file}`);
  }
});
