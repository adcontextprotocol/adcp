#!/usr/bin/env node
/**
 * adagents.json catalog-only community-mirror schema behavior.
 *
 * A community mirror for a platform that has not adopted AdCP carries catalog
 * content (formats/properties/placements) but has no sales agent to authorize,
 * so `authorized_agents` is empty ([]). This test pins the schema's behavior:
 *
 *   - empty authorized_agents + catalog content   => VALID
 *   - the shipped Meta community-mirror fixture    => VALID
 *   - a normal file with >=1 authorized agent      => VALID (regression)
 *   - empty authorized_agents + NO catalog content => INVALID
 *   - catalog_etag alone (no catalog arrays)       => INVALID
 *
 * Regression guard: the registry previously enforced `minItems: 1` on
 * `authorized_agents`, rejecting the exact `authorized_agents: []` shape the
 * SDK's buildCommunityMirrorAdagents() emits.
 *
 * Run: npm run test:adagents-catalog-only
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const SCHEMA_BASE_DIR = path.resolve(__dirname, '../static/schemas/source');
const ADAGENTS_SCHEMA = path.join(SCHEMA_BASE_DIR, 'adagents.json');
const META_FIXTURE = path.resolve(
  __dirname,
  '../static/examples/adagents/community/meta.json'
);

function loadExternalSchema(uri) {
  if (!uri.startsWith('/schemas/')) {
    throw new Error(`Cannot load external schema: ${uri}`);
  }
  const p = path.join(SCHEMA_BASE_DIR, uri.replace('/schemas/', ''));
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

async function compileAdagents() {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    discriminator: true,
    loadSchema: async (uri) => loadExternalSchema(uri),
  });
  addFormats(ajv);
  const schema = JSON.parse(fs.readFileSync(ADAGENTS_SCHEMA, 'utf8'));
  return ajv.compileAsync(schema);
}

const MINIMAL_PROPERTY = {
  property_id: 'example_site',
  property_type: 'website',
  name: 'Example Site',
  identifiers: [{ type: 'domain', value: 'example.com' }],
  publisher_domain: 'example.com',
};

test('catalog-only mirror: empty authorized_agents + catalog content is valid', async () => {
  const validate = await compileAdagents();
  const ok = validate({
    $schema: '/schemas/adagents.json',
    catalog_etag: 'example-2026-06-04',
    properties: [MINIMAL_PROPERTY],
    authorized_agents: [],
  });
  assert.equal(ok, true, JSON.stringify(validate.errors));
});

test('shipped Meta community-mirror fixture validates against the schema', async () => {
  const validate = await compileAdagents();
  const meta = JSON.parse(fs.readFileSync(META_FIXTURE, 'utf8'));
  assert.deepEqual(
    meta.authorized_agents,
    [],
    'the Meta mirror fixture should assert no sales authorization'
  );
  const ok = validate(meta);
  assert.equal(ok, true, JSON.stringify(validate.errors));
});

test('normal file with >=1 authorized agent stays valid (regression)', async () => {
  const validate = await compileAdagents();
  const ok = validate({
    $schema: '/schemas/adagents.json',
    properties: [MINIMAL_PROPERTY],
    authorized_agents: [
      {
        url: 'https://agent.example.com',
        authorized_for: 'All properties',
        authorization_type: 'property_tags',
        property_tags: ['all'],
      },
    ],
  });
  assert.equal(ok, true, JSON.stringify(validate.errors));
});

test('empty authorized_agents with no catalog content is rejected', async () => {
  const validate = await compileAdagents();
  const ok = validate({
    $schema: '/schemas/adagents.json',
    authorized_agents: [],
  });
  assert.equal(
    ok,
    false,
    'a file with neither sales authorization nor catalog content must be invalid'
  );
});

test('catalog_etag alone does not satisfy the content guard', async () => {
  const validate = await compileAdagents();
  const ok = validate({
    $schema: '/schemas/adagents.json',
    catalog_etag: 'x',
    authorized_agents: [],
  });
  assert.equal(
    ok,
    false,
    'catalog_etag without formats/properties/placements/collections/signals must not validate'
  );
});

// Every catalog arm of the content guard must require a NON-EMPTY array, not
// just presence of the key — otherwise an empty array sneaks a contentless file
// past the guard (collections has no per-field minItems, so this is the arm
// that actually broke; the others are pinned here too to prevent regression).
for (const field of ['collections', 'formats', 'properties', 'placements', 'signals']) {
  test(`empty ${field}:[] with no authorization is rejected`, async () => {
    const validate = await compileAdagents();
    const ok = validate({
      $schema: '/schemas/adagents.json',
      authorized_agents: [],
      [field]: [],
    });
    assert.equal(
      ok,
      false,
      `an empty ${field} array carries no catalog content and must not satisfy the guard`
    );
  });
}

test('collections-only mirror with a real collection is valid', async () => {
  const validate = await compileAdagents();
  const ok = validate({
    $schema: '/schemas/adagents.json',
    catalog_etag: 'example-2026-06-04',
    collections: [{ collection_id: 'example_collection', name: 'Example Collection' }],
    authorized_agents: [],
  });
  assert.equal(ok, true, JSON.stringify(validate.errors));
});
