'use strict';

// #8791 step 1: enum values that collide with SDK reserved words or with the
// enum member protocol (`pass`, `global`, `name`) gain a replacement in
// 3.3. Both values are accepted through 3.x; the old one is deprecated and
// removed in 4.0.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_ROOT = path.join(__dirname, '../static/schemas/source');

const REPLACEMENTS = [
  ['enums/binary-verdict.json', '', 'pass', 'passed'],
  [
    'content-standards/get-media-buy-artifacts-response.json',
    '/oneOf/0/properties/artifacts/items/properties/local_verdict',
    'pass',
    'passed',
  ],
  ['core/registry-event.json', '/$defs/compliancePayload/properties/tracks/additionalProperties', 'pass', 'passed'],
  ['error-details/rate-limited.json', '/properties/scope', 'global', 'agent'],
  ['core/signal-definition.json', '/properties/onboarder/properties/match_keys/items', 'name', 'full_name'],
  ['core/signal-definition-enrichment.json', '/properties/onboarder/properties/match_keys/items', 'name', 'full_name'],
];

function readSchema(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(SCHEMA_ROOT, relativePath), 'utf8'));
}

function at(document, pointer) {
  return pointer
    .split('/')
    .slice(1)
    .map(segment => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
    .reduce((node, segment) => node[segment], document);
}

async function compile(schema) {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    loadSchema: async uri => readSchema(uri.replace(/^\/schemas\//, '')),
  });
  addFormats(ajv);
  return ajv.compileAsync(schema);
}

test('each replaced value is accepted beside its deprecated original', () => {
  for (const [file, pointer, oldValue, newValue] of REPLACEMENTS) {
    const node = at(readSchema(file), pointer);
    const site = `${file}#${pointer}`;
    assert.ok(node.enum.includes(oldValue), `${site} still accepts ${oldValue}`);
    assert.ok(node.enum.includes(newValue), `${site} accepts ${newValue}`);
    assert.ok(node['x-deprecated-enum-values'].includes(oldValue), `${site} lists ${oldValue} as deprecated`);
    assert.ok(!node['x-deprecated-enum-values'].includes(newValue), `${site} does not deprecate ${newValue}`);
    assert.deepEqual(
      node.enumMetadata[oldValue],
      { deprecated: true, 'x-deprecated-in': '3.3.0', 'x-removed-in': '4.0.0', 'x-superseded-by': newValue },
      `${site} enumMetadata.${oldValue}`,
    );
  }
});

test('x-deprecated-enum-values only lists values the enum still accepts', () => {
  const offenders = [];
  const visit = (node, site) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node['x-deprecated-enum-values'])) {
      for (const value of node['x-deprecated-enum-values']) {
        if (!Array.isArray(node.enum) || !node.enum.includes(value)) offenders.push(`${site}: ${value}`);
      }
    }
    for (const [key, child] of Object.entries(node)) visit(child, `${site}/${key}`);
  };
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.json')) {
        visit(JSON.parse(fs.readFileSync(full, 'utf8')), `${path.relative(SCHEMA_ROOT, full)}#`);
      }
    }
  };
  walk(SCHEMA_ROOT);
  assert.deepEqual(offenders, []);
});

test('rate-limited scope accepts agent and the deprecated global', async () => {
  const validate = await compile(readSchema('error-details/rate-limited.json'));
  for (const scope of ['account', 'tool', 'global', 'agent']) {
    assert.equal(validate({ limit: 10, remaining: 0, window_seconds: 60, scope }), true, scope);
  }
});
