#!/usr/bin/env node
/**
 * A hoisted enum keeps each call-site's own annotations.
 *
 * `resolveRefs` merges keys written beside a `$ref` into the inlined enum,
 * so occurrences of one enum can differ in `description`, `default` or
 * `deprecated`. The enum hoist gives them one root `$defs` entry that holds
 * only what every occurrence shares, and keeps each occurrence's own
 * annotations beside its `$ref`. At every site, the hoisted entry plus the
 * keys beside the `$ref` give the annotations the source gives there.
 *
 * Each case runs scripts/build-schemas.cjs with `--root` against a small
 * fixture tree, then reads the bundled roots.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const {
  writeFixtureTree, removeFixtureTrees, runBuild, readBundled,
} = require('./helpers/build-schemas-fixture.cjs');

const ALPHA = 'core/tasks-get-alpha-request.json';
const BETA = 'core/tasks-get-beta-request.json';

test.after(removeFixtureTrees);

const STATUS = {
  title: 'Status',
  description: 'Status of a thing.',
  type: 'string',
  enum: ['active', 'paused'],
  enumDescriptions: { active: 'Running.', paused: 'Stopped.' },
};
const DEPRECATION = {
  deprecated: true,
  'x-deprecated-in': '3.3.0',
  description: 'Deprecated in 3.3. The single-value form: send a one-item array instead.',
};
const ref = { $ref: '/schemas/enums/status.json' };
const root = (relativePath, properties) => ({
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: `/schemas/${relativePath}`,
  type: 'object',
  properties,
});

// Each site, the keys written beside its `$ref` in the source.
const ALPHA_SITES = {
  '/properties/plain': {},
  '/properties/described': { description: 'Status of the described field.' },
  '/properties/defaulted': { default: 'active' },
  '/properties/filter/oneOf/0': DEPRECATION,
  '/properties/filter/oneOf/1/items': {},
};

let alpha;
let beta;
test.before(async () => {
  const tree = writeFixtureTree({
    'enums/status.json': {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: '/schemas/enums/status.json',
      ...STATUS,
    },
    [ALPHA]: root(ALPHA, {
      plain: ref,
      described: { ...ref, ...ALPHA_SITES['/properties/described'] },
      defaulted: { ...ref, ...ALPHA_SITES['/properties/defaulted'] },
      filter: {
        oneOf: [
          { ...ref, ...DEPRECATION },
          { type: 'array', items: ref, minItems: 1 },
        ],
      },
    }),
    // An inline copy of the enum without a description: the hoisted entry
    // cannot carry the enum file's description for both sites.
    [BETA]: root(BETA, {
      referenced: ref,
      inline: { title: 'Status', type: 'string', enum: ['active', 'paused'], enumDescriptions: STATUS.enumDescriptions },
    }),
  });
  const { status, output } = await runBuild(tree);
  assert.equal(status, 0, output);
  alpha = readBundled(tree, ALPHA);
  beta = readBundled(tree, BETA);
});

const at = (doc, pointer) => pointer.split('/').slice(1).reduce((node, key) => node[key], doc);

/** The annotations and enum a site gets: the `$ref` target, then the keys beside it. */
function effective(doc, pointer) {
  const { $ref, ...beside } = at(doc, pointer);
  assert.match($ref, /^#\/\$defs\//, `${pointer} is a $ref to the hoisted enum`);
  const { $id, ...target } = at(doc, $ref.slice(1));
  return { ...target, ...beside };
}

test('every occurrence points at one hoisted entry', () => {
  for (const pointer of Object.keys(ALPHA_SITES)) {
    assert.equal(at(alpha, pointer).$ref, '#/$defs/Status', pointer);
  }
  assert.deepEqual(Object.keys(alpha.$defs), ['Status']);
});

test('each site keeps the annotations its source gives it', () => {
  for (const [pointer, beside] of Object.entries(ALPHA_SITES)) {
    assert.deepEqual(effective(alpha, pointer), { ...STATUS, ...beside }, pointer);
  }
});

test('the hoisted entry holds only what every occurrence shares', () => {
  const { $id, ...entry } = alpha.$defs.Status;
  assert.deepEqual(entry, STATUS);
  assert.deepEqual(at(alpha, '/properties/plain'), { $ref: '#/$defs/Status' });
});

test('a description that one occurrence lacks stays at the sites that have it', () => {
  assert.equal(beta.$defs.Status.description, undefined);
  assert.equal(effective(beta, '/properties/referenced').description, STATUS.description);
  assert.equal(effective(beta, '/properties/inline').description, undefined);
});

test('the bundled roots validate as their sources do', () => {
  const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true });
  addFormats(ajv);
  const { _bundled, ...schema } = alpha;
  const validate = ajv.compile(schema);
  assert.equal(validate({ plain: 'active', filter: ['paused'], defaulted: 'paused' }), true);
  assert.equal(validate({ filter: 'active' }), true);
  assert.equal(validate({ described: 'archived' }), false);
  assert.equal(validate({ filter: [] }), false);
});
