#!/usr/bin/env node
/**
 * Seeded storyboard fixtures must resolve every discriminated union they
 * carry against this release's schemas.
 *
 * Storyboards seed sellers through `comply_test_controller` `seed_*`
 * scenarios, either from a top-level `fixtures:` block or from an inline
 * seed step's `params.fixture`. Fixtures are sparse: the seller fills the
 * fields a fixture omits from its own baseline, so a missing top-level
 * `name` or `reporting_capabilities` is fine. A discriminator is different.
 * Arrays replace the baseline wholesale and the seller cannot guess which
 * branch an entry meant, so an entry that omits its discriminator (or names
 * an unknown one) is echoed as authored and fails the storyboard's own
 * response-schema check. #8646 was this shape: two `publisher_properties`
 * entries with only `publisher_domain`, while every branch of
 * `core/publisher-property-selector.json` requires `selection_type`.
 *
 * The check validates each seeded object against its domain schema with
 * Ajv's `discriminator` support and fails on any `discriminator` error. Other
 * schema errors are left to the seller's baseline merge and are not graded
 * here.
 *
 * From 3.2, a `fixtures:` entry can be a bare handle that a top-level
 * `fixture_resolution` entry resolves only by discovering a seller-owned
 * entity (DR-0010, `universal/storyboard-schema.yaml`). Such an entry is
 * never seeded, so it is skipped. An entry with no resolution entry keeps the
 * effective `[seed]` strategy and is graded.
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
const STORYBOARD_ROOT = path.join(__dirname, '..', 'static', 'compliance', 'source');

// Each seed kind, the schema a seller echoes it back under, and the id
// fields the runner lifts out of the fixture into the seed params.
const SEED_KINDS = {
  products: {
    scenario: 'seed_product',
    schema: '/schemas/core/product.json',
    ids: ['product_id'],
  },
  pricing_options: {
    scenario: 'seed_pricing_option',
    schema: '/schemas/core/pricing-option.json',
    ids: ['product_id', 'pricing_option_id'],
  },
  accounts: {
    scenario: 'seed_account',
    schema: '/schemas/core/account.json',
    ids: ['account_id'],
  },
  creative_formats: {
    scenario: 'seed_creative_format',
    schema: '/schemas/core/format.json',
    ids: ['format_id'],
  },
  creatives: {
    scenario: 'seed_creative',
    schema: '/schemas/creative/list-creatives-completed.json#/properties/creatives/items',
    ids: ['creative_id'],
  },
  media_buys: {
    scenario: 'seed_media_buy',
    schema: '/schemas/core/media-buy.json',
    ids: ['media_buy_id'],
  },
  plans: {
    scenario: 'seed_plan',
    schema: '/schemas/governance/sync-plans-request.json#/properties/plans/items',
    ids: ['plan_id'],
  },
};

const KIND_BY_SCENARIO = Object.fromEntries(
  Object.entries(SEED_KINDS).map(([kind, def]) => [def.scenario, kind]),
);

function buildAjv() {
  const ajv = new Ajv({ strict: false, allErrors: true, discriminator: true });
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

/**
 * The object a seller holds after seeding: the fixture payload with the
 * lifted ids put back. `{ <id>, fixture: {...} }` entries (accounts,
 * creative formats) carry their payload under `fixture`.
 */
function seededObject(kind, entry) {
  const { ids } = SEED_KINDS[kind];
  const rest = { ...entry };
  const lifted = {};
  for (const id of ids) {
    if (id in rest) {
      lifted[id] = rest[id];
      delete rest[id];
    }
  }
  const keys = Object.keys(rest);
  const payload =
    keys.length === 1 && keys[0] === 'fixture' && rest.fixture && typeof rest.fixture === 'object'
      ? rest.fixture
      : rest;
  // The pricing option's product_id and a creative format's string format_id
  // are routing keys, not fields of the echoed object.
  const echoed = { ...payload };
  for (const [id, value] of Object.entries(lifted)) {
    if (kind === 'pricing_options' && id === 'product_id') continue;
    if (kind === 'creative_formats' && id === 'format_id') continue;
    if (!(id in echoed)) echoed[id] = value;
  }
  return echoed;
}

/**
 * Whether a `fixtures:` entry reaches the seller through `seed_*`. Handles
 * are keyed as in `scripts/lint-storyboard-fixture-resolution.cjs`: a pricing
 * option by (product_handle, handle), everything else by its id field.
 */
function isSeeded(doc, kind, entry) {
  const resolutions = doc.fixture_resolution && doc.fixture_resolution[kind];
  if (!Array.isArray(resolutions)) return true;
  const key = (product, id) => `${product ?? ''}\0${id ?? ''}`;
  const idField = SEED_KINDS[kind].ids[SEED_KINDS[kind].ids.length - 1];
  const resolution = resolutions.find((r) =>
    kind === 'pricing_options'
      ? key(r && r.product_handle, r && r.handle) === key(entry.product_id, entry.pricing_option_id)
      : r && r.handle === entry[idField],
  );
  return !resolution || !Array.isArray(resolution.strategies) || resolution.strategies.includes('seed');
}

/** Every seeded object in one storyboard document. */
function seededObjects(doc) {
  const out = [];
  if (doc && doc.fixtures && typeof doc.fixtures === 'object') {
    for (const [kind, list] of Object.entries(doc.fixtures)) {
      if (!SEED_KINDS[kind] || !Array.isArray(list)) continue;
      list.forEach((entry, i) => {
        if (!entry || typeof entry !== 'object' || !isSeeded(doc, kind, entry)) return;
        out.push({ where: `fixtures.${kind}[${i}]`, kind, object: seededObject(kind, entry) });
      });
    }
  }
  (function walk(node) {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const request = node.sample_request;
    const kind = request && KIND_BY_SCENARIO[request.scenario];
    if (node.task === 'comply_test_controller' && kind && request.params && request.params.fixture) {
      const { fixture, ...ids } = request.params;
      out.push({ where: `step ${node.id}`, kind, object: seededObject(kind, { ...ids, fixture }) });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'fixtures') walk(value);
    }
  })(doc);
  return out;
}

function discriminatorErrors(ajv, kind, object) {
  const validate = ajv.getSchema(SEED_KINDS[kind].schema);
  assert.ok(validate, `${SEED_KINDS[kind].schema} is not loaded`);
  if (validate(object)) return [];
  return validate.errors
    .filter((e) => e.keyword === 'discriminator')
    .map((e) =>
      e.params.error === 'tag'
        ? `${e.instancePath || '/'} is missing its discriminator "${e.params.tag}"`
        : `${e.instancePath || '/'} has ${e.params.tag}=${JSON.stringify(e.params.tagValue)}, which matches no branch`,
    );
}

const ajv = buildAjv();

test('every seeded storyboard fixture resolves its discriminated unions', () => {
  const failures = [];
  let checked = 0;
  for (const file of yamlFiles(STORYBOARD_ROOT)) {
    const doc = YAML.parse(fs.readFileSync(file, 'utf8'));
    for (const { where, kind, object } of seededObjects(doc)) {
      checked += 1;
      for (const error of discriminatorErrors(ajv, kind, object)) {
        failures.push(`${path.relative(STORYBOARD_ROOT, file)} ${where}: ${error}`);
      }
    }
  }
  assert.ok(checked > 100, `only ${checked} seeded fixtures found; the storyboard walk is broken`);
  assert.deepEqual(failures, []);
});

test('a publisher_properties entry without selection_type is rejected (#8646)', () => {
  const product = {
    product_id: 'p',
    publisher_properties: [{ publisher_domain: 'acmeoutdoor.example', selection_type: 'all' }],
  };
  assert.deepEqual(discriminatorErrors(ajv, 'products', product), []);
  const missing = { ...product, publisher_properties: [{ publisher_domain: 'acmeoutdoor.example' }] };
  assert.deepEqual(discriminatorErrors(ajv, 'products', missing), [
    '/publisher_properties/0 is missing its discriminator "selection_type"',
  ]);
  const unknown = {
    ...product,
    publisher_properties: [{ publisher_domain: 'acmeoutdoor.example', selection_type: 'everything' }],
  };
  assert.equal(discriminatorErrors(ajv, 'products', unknown).length, 1);
});

test('sparse fixtures are not graded beyond their discriminators', () => {
  // No name, description, pricing_options, or reporting_capabilities: the
  // seller fills those from its baseline.
  assert.deepEqual(discriminatorErrors(ajv, 'products', { product_id: 'p', delivery_type: 'non_guaranteed' }), []);
});

test('inline seed steps and fixture blocks are both collected', () => {
  const doc = YAML.parse(`
fixtures:
  pricing_options:
    - product_id: p
      pricing_option_id: po
      currency: USD
  accounts:
    - account_id: a
      fixture:
        status: active
phases:
  - id: seed
    steps:
      - id: seed_p
        task: comply_test_controller
        sample_request:
          scenario: seed_product
          params:
            product_id: p
            fixture:
              publisher_properties:
                - publisher_domain: pub.example
`);
  const objects = seededObjects(doc);
  assert.deepEqual(
    objects.map((o) => [o.where, o.kind]),
    [
      ['fixtures.pricing_options[0]', 'pricing_options'],
      ['fixtures.accounts[0]', 'accounts'],
      ['step seed_p', 'products'],
    ],
  );
  assert.deepEqual(objects[1].object, { status: 'active', account_id: 'a' });
  assert.deepEqual(discriminatorErrors(ajv, 'pricing_options', objects[0].object), [
    '/ is missing its discriminator "pricing_model"',
  ]);
  assert.deepEqual(discriminatorErrors(ajv, 'products', objects[2].object), [
    '/publisher_properties/0 is missing its discriminator "selection_type"',
  ]);
});

test('discover-only fixture handles are not graded as seeds', () => {
  const doc = YAML.parse(`
fixtures:
  products:
    - product_id: discovered
    - product_id: seeded_or_discovered
      delivery_type: non_guaranteed
  pricing_options:
    - product_id: discovered
      pricing_option_id: po
    - product_id: seeded_or_discovered
      pricing_option_id: po
      currency: USD
    - product_id: unresolved
      pricing_option_id: po
      currency: USD
fixture_resolution:
  products:
    - handle: discovered
      strategies: [discover]
    - handle: seeded_or_discovered
      strategies: [seed, discover]
  pricing_options:
    - product_handle: discovered
      handle: po
      strategies: [discover]
    - product_handle: seeded_or_discovered
      handle: po
      strategies: [seed, discover]
`);
  assert.deepEqual(
    seededObjects(doc).map((o) => o.where),
    ['fixtures.products[1]', 'fixtures.pricing_options[1]', 'fixtures.pricing_options[2]'],
  );
});
