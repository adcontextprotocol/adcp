#!/usr/bin/env node
/**
 * Unit tests for hoistBySourceIdentity in scripts/build-schemas.cjs.
 *
 * The function resolves $refs like `resolveRefs`, except refs to listed
 * source schemas (core/provenance.json) are written once to root $defs and
 * every call-site becomes `{ $ref: "#/$defs/Provenance", ...siblings }`.
 * Unlike `x-adcp-hoist`, call-site siblings (notably `description`) survive.
 *
 * See issue #4875.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { hoistBySourceIdentity, resolveRefs, generateBundledSchemas } = require('../scripts/build-schemas.cjs');

const PROV = '/schemas/core/provenance.json';

function makeSourceDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hoist-identity-'));
  fs.mkdirSync(path.join(dir, 'core'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'enums'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'enums/source-type.json'), JSON.stringify({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/enums/source-type.json',
    type: 'string',
    enum: ['human', 'ai'],
  }));
  fs.writeFileSync(path.join(dir, 'core/provenance.json'), JSON.stringify({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: PROV,
    title: 'Provenance',
    description: 'Declares how content was produced.',
    type: 'object',
    properties: { source_type: { $ref: '/schemas/enums/source-type.json' } },
  }));
  return dir;
}

test('hoists provenance to $defs and rewrites call-sites to a local $ref', (t) => {
  const dir = makeSourceDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const schema = {
    type: 'object',
    properties: { a: { $ref: PROV }, b: { $ref: PROV } },
  };
  const result = hoistBySourceIdentity(schema, dir, [PROV]);

  assert.deepEqual(result.properties.a, { $ref: '#/$defs/Provenance' });
  assert.deepEqual(result.properties.b, { $ref: '#/$defs/Provenance' });
  assert.equal(result.$defs.Provenance.title, 'Provenance');
  assert.equal(result.$defs.Provenance.description, 'Declares how content was produced.');
  assert.equal(result.$defs.Provenance.$schema, undefined);
});

test('preserves call-site description siblings', (t) => {
  const dir = makeSourceDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const schema = {
    properties: {
      a: { $ref: PROV, description: 'overrides manifest-level provenance' },
      b: { $ref: PROV },
    },
  };
  const result = hoistBySourceIdentity(schema, dir, [PROV]);

  assert.deepEqual(result.properties.a, {
    $ref: '#/$defs/Provenance',
    description: 'overrides manifest-level provenance',
  });
  // The $defs entry keeps provenance's own description, not a call-site one.
  assert.equal(result.$defs.Provenance.description, 'Declares how content was produced.');
});

test('every distinct call-site description survives, including through nested file refs', (t) => {
  const dir = makeSourceDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'core/assets'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'core/assets/image.json'), JSON.stringify({
    $id: '/schemas/core/assets/image.json',
    type: 'object',
    properties: { provenance: { $ref: PROV, description: 'image-level override' } },
  }));
  const schema = {
    properties: {
      top: { $ref: PROV, description: 'artifact default' },
      image: { $ref: '/schemas/core/assets/image.json' },
      bare: { $ref: PROV },
    },
  };
  const result = hoistBySourceIdentity(schema, dir, [PROV]);

  assert.equal(result.properties.top.description, 'artifact default');
  assert.equal(result.properties.image.properties.provenance.description, 'image-level override');
  assert.equal(result.properties.image.properties.provenance.$ref, '#/$defs/Provenance');
  assert.deepEqual(result.properties.bare, { $ref: '#/$defs/Provenance' });
  assert.equal(Object.keys(result.$defs).length, 1);
});

test('refs inside the hoisted body are resolved inline', (t) => {
  const dir = makeSourceDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const schema = { properties: { a: { $ref: PROV }, b: { $ref: PROV } } };
  const result = hoistBySourceIdentity(schema, dir, [PROV]);

  const inner = result.$defs.Provenance.properties.source_type;
  assert.deepEqual(inner.enum, ['human', 'ai']);
  assert.equal(inner.$ref, undefined);
});

test('no-op when the ref is absent or appears only once', (t) => {
  const dir = makeSourceDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const absent = { properties: { a: { type: 'string' } } };
  assert.deepEqual(hoistBySourceIdentity(absent, dir, [PROV]), absent);

  // A single call-site is inlined exactly as `resolveRefs` would.
  const once = { properties: { a: { $ref: PROV, description: 'only one' } } };
  const result = hoistBySourceIdentity(once, dir, [PROV]);
  assert.equal(result.$defs, undefined);
  assert.deepEqual(result, resolveRefs(once, dir));
});

test('throws when root $defs already defines the target name', (t) => {
  const dir = makeSourceDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const schema = {
    $defs: { Provenance: { type: 'string' } },
    properties: { a: { $ref: PROV }, b: { $ref: PROV } },
  };
  assert.throws(() => hoistBySourceIdentity(schema, dir, [PROV]), /already defines 'Provenance'/);
});

test('rejects fragment refs, non-/schemas/ refs, and untitled sources', (t) => {
  const dir = makeSourceDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => hoistBySourceIdentity({}, dir, [`${PROV}#/properties/x`]), /without a fragment/);
  assert.throws(() => hoistBySourceIdentity({}, dir, ['core/provenance.json']), /without a fragment/);
  fs.writeFileSync(path.join(dir, 'core/untitled.json'), JSON.stringify({ type: 'object' }));
  assert.throws(() => hoistBySourceIdentity({}, dir, ['/schemas/core/untitled.json']), /usable `title`/);
});

test('ignores a listed ref whose source file does not exist', (t) => {
  const dir = makeSourceDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const schema = { properties: { a: { type: 'string' } } };
  assert.deepEqual(hoistBySourceIdentity(schema, dir, ['/schemas/core/missing.json']), schema);
});

test('hoists the repeated ref and inlines the singleton when several are listed', (t) => {
  const dir = makeSourceDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'core/once.json'), JSON.stringify({
    $id: '/schemas/core/once.json',
    title: 'Once',
    type: 'string',
  }));
  const schema = {
    properties: {
      a: { $ref: PROV }, b: { $ref: PROV }, c: { $ref: '/schemas/core/once.json', description: 'c' },
    },
  };
  const result = hoistBySourceIdentity(schema, dir, [PROV, '/schemas/core/once.json']);

  assert.deepEqual(Object.keys(result.$defs), ['Provenance']);
  assert.deepEqual(result.properties.a, { $ref: '#/$defs/Provenance' });
  assert.equal(result.properties.c.type, 'string');
  assert.equal(result.properties.c.$ref, undefined);
});

test('resolveRefs without options still inlines every ref', (t) => {
  const dir = makeSourceDir();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const result = resolveRefs({ properties: { a: { $ref: PROV, description: 'x' } } }, dir);
  assert.equal(result.properties.a.title, 'Provenance');
  assert.equal(result.properties.a.$ref, undefined);
});

test('generateBundledSchemas hoists provenance end to end and the bundle compiles', async (t) => {
  const Ajv = require('ajv');
  const dir = makeSourceDir();
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hoist-identity-out-'));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(out, { recursive: true, force: true });
  });
  const rel = path.join('media-buy', 'x-response.json');
  fs.mkdirSync(path.join(dir, 'media-buy'), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), JSON.stringify({
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: '/schemas/media-buy/x-response.json',
    type: 'object',
    properties: {
      a: { $ref: PROV, description: 'a-site' },
      b: { $ref: PROV, description: 'b-site' },
    },
  }));

  assert.deepEqual(await generateBundledSchemas(dir, out, '3.2.1'), { successCount: 1, errorCount: 0 });
  const bundled = JSON.parse(fs.readFileSync(path.join(out, rel), 'utf8'));
  assert.equal(bundled.properties.a.$ref, '#/$defs/Provenance');
  assert.equal(bundled.properties.a.description, 'a-site');
  assert.equal(bundled.properties.b.description, 'b-site');
  assert.equal(bundled.$defs.Provenance.title, 'Provenance');

  const validate = new Ajv({ strict: false }).compile(bundled);
  assert.equal(validate({ a: { source_type: 'ai' }, b: {} }), true);
  assert.equal(validate({ a: { source_type: 'robot' } }), false);
});

test('real source tree: core/provenance.json is hoisted (guards the missing-file skip)', () => {
  const sourceDir = path.join(__dirname, '../static/schemas/source');
  const schema = { properties: { a: { $ref: PROV }, b: { $ref: PROV } } };
  const result = hoistBySourceIdentity(schema, sourceDir, [PROV]);
  assert.equal(result.properties.a.$ref, '#/$defs/Provenance');
  assert.equal(result.$defs.Provenance.title, 'Provenance');
});
