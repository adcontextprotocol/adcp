#!/usr/bin/env node
/**
 * The bundler's content-based hoists look inside `definitions` and `$defs`.
 *
 * Bundling moves an inlined document's `definitions` to the bundle root. A
 * marked schema (`x-adcp-hoist`) or a repeated enum inside such an entry is
 * hoisted to root `$defs` like one anywhere else, so a large shared
 * definition does not keep its contents inline at every site. The entry
 * itself is already a named definition: it is neither counted as an
 * occurrence nor replaced.
 *
 * Each case runs scripts/build-schemas.cjs with `--root` against a small
 * fixture tree, then validates instances against the bundled root.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const {
  writeFixtureTree, removeFixtureTrees, runBuild, readBundled,
} = require('./helpers/build-schemas-fixture.cjs');

const ROOT = 'core/tasks-get-alpha-request.json';

test.after(removeFixtureTrees);

const enumSchema = (relativePath, title, values) => ({
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: `/schemas/${relativePath}`,
  title,
  type: 'string',
  enum: values,
});

const markedSchema = (relativePath, title) => ({
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: `/schemas/${relativePath}`,
  'x-adcp-hoist': true,
  title,
  type: 'object',
  properties: { url: { type: 'string' } },
  required: ['url'],
});

/**
 * The root references a manifest document whose fields live under its own
 * `definitions`, the layout #9121 used for `creative-manifest-base`.
 * - `Status` appears twice inside the `manifest-base` entry.
 * - `FixtureAsset` (marked) appears once, inside the `manifest-base` entry.
 * - `Channel` is a `definitions` entry and appears once more inline.
 * - `FixtureLogo` (marked) appears only as a `definitions` entry.
 */
function writeTree() {
  return writeFixtureTree({
    'enums/status.json': enumSchema('enums/status.json', 'Status', ['active', 'paused']),
    'enums/channel.json': enumSchema('enums/channel.json', 'Channel', ['display', 'video']),
    'core/asset.json': markedSchema('core/asset.json', 'FixtureAsset'),
    'core/logo.json': markedSchema('core/logo.json', 'FixtureLogo'),
    'core/manifest.json': {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: '/schemas/core/manifest.json',
      definitions: {
        'manifest-base': {
          type: 'object',
          properties: {
            status: { $ref: '/schemas/enums/status.json' },
            previous_status: { $ref: '/schemas/enums/status.json' },
            asset: { $ref: '/schemas/core/asset.json' },
          },
        },
        channel: { $ref: '/schemas/enums/channel.json' },
        logo: { $ref: '/schemas/core/logo.json' },
      },
      allOf: [{ $ref: '#/definitions/manifest-base' }],
    },
    [ROOT]: {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: `/schemas/${ROOT}`,
      type: 'object',
      properties: {
        manifest: { $ref: '/schemas/core/manifest.json' },
        channel: { $ref: '/schemas/enums/channel.json' },
      },
    },
  });
}

let bundled;
test.before(async () => {
  const root = writeTree();
  const { status, output } = await runBuild(root);
  assert.equal(status, 0, output);
  bundled = readBundled(root, ROOT);
});

test('a marked schema inside an inlined document\'s definitions is hoisted', () => {
  const base = bundled.definitions['manifest-base'];
  assert.deepEqual(base.properties.asset, { $ref: '#/$defs/FixtureAsset' });
  assert.equal(bundled.$defs.FixtureAsset.title, 'FixtureAsset');
  assert.equal(bundled.$defs.FixtureAsset['x-adcp-hoist'], undefined);
});

test('a repeated enum inside an inlined document\'s definitions is hoisted', () => {
  const base = bundled.definitions['manifest-base'];
  assert.deepEqual(base.properties.status, { $ref: '#/$defs/Status' });
  assert.deepEqual(base.properties.previous_status, { $ref: '#/$defs/Status' });
  assert.deepEqual(bundled.$defs.Status.enum, ['active', 'paused']);
});

test('a definitions entry is not counted as an occurrence', () => {
  // `Channel` is a definitions entry plus one inline use: one occurrence.
  assert.equal(bundled.$defs?.Channel, undefined);
  assert.deepEqual(bundled.properties.channel.enum, ['display', 'video']);
  assert.deepEqual(bundled.definitions.channel.enum, ['display', 'video']);
  // `FixtureLogo` is marked but only a definitions entry: it stays there.
  assert.equal(bundled.$defs?.FixtureLogo, undefined);
  assert.equal(bundled.definitions.logo.title, 'FixtureLogo');
  assert.equal(JSON.stringify(bundled).includes('x-adcp-hoist'), false);
});

test('the bundled root validates as its source does', () => {
  const ajv = new Ajv({ allErrors: true, strict: false, discriminator: true });
  addFormats(ajv);
  const { _bundled, ...schema } = bundled;
  const validate = ajv.compile(schema);
  const accepts = instance => validate(instance) || validate.errors;
  assert.equal(accepts({ manifest: { status: 'active', asset: { url: 'https://a.example' } } }), true);
  assert.equal(accepts({ channel: 'video', manifest: { previous_status: 'paused' } }), true);
  assert.equal(validate({ manifest: { status: 'archived' } }), false);
  assert.equal(validate({ manifest: { asset: {} } }), false);
  assert.equal(validate({ channel: 'audio' }), false);
});
