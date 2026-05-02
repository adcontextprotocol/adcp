#!/usr/bin/env node
/**
 * Unit tests for sub-schema $id preservation during bundling (#3868).
 *
 * Two functions in scripts/build-schemas.cjs share the contract:
 *
 *   - resolveRefs: when inlining a $ref'd schema into its parent, preserve
 *     the inlined schema's $id on the merged subtree. Defensive: if the
 *     parent already has its own $id (the deprecated-alias pattern, e.g.
 *     core/signal-pricing-option.json), keep the parent's $id.
 *
 *   - versionInlineSchemaIds: post-pass that rewrites every nested $id from
 *     source-form (/schemas/core/foo.json) to the versioned flat-tree URI
 *     (/schemas/{version}/core/foo.json). The root $id is left for the
 *     bundled-prefix rewrite that runs separately.
 *
 * Tests cover the alias-wins case, the no-version-double-stamp guard, the
 * isRoot propagation through arrays, and external/relative $id passthrough.
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveRefs, versionInlineSchemaIds } = require('../scripts/build-schemas.cjs');

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function withSourceTree(files, fn) {
  // Materialize a synthetic source tree so resolveRefs can read $refs from
  // disk. resolveRefs reads files directly via fs.readFileSync(refPath); a
  // pure in-memory mock would diverge from production behavior.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-resolveRefs-'));
  try {
    for (const [relPath, content] of Object.entries(files)) {
      const full = path.join(dir, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, JSON.stringify(content));
    }
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('resolveRefs preserves $id on inlined subtree', () => {
  withSourceTree({
    'core/activation-key.json': {
      $id: '/schemas/core/activation-key.json',
      title: 'Activation Key',
      oneOf: [{ properties: { type: { const: 'segment_id' } } }],
    },
  }, (sourceDir) => {
    const parent = {
      properties: {
        activation_key: { $ref: '/schemas/core/activation-key.json' },
      },
    };
    const result = resolveRefs(clone(parent), sourceDir);
    assert.equal(result.properties.activation_key.$id, '/schemas/core/activation-key.json');
    assert.equal(result.properties.activation_key.title, 'Activation Key');
    assert.ok(result.properties.activation_key.oneOf);
  });
});

test('resolveRefs strips $schema from inlined subtree', () => {
  withSourceTree({
    'core/foo.json': {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: '/schemas/core/foo.json',
      type: 'object',
    },
  }, (sourceDir) => {
    const parent = { allOf: [{ $ref: '/schemas/core/foo.json' }] };
    const result = resolveRefs(clone(parent), sourceDir);
    assert.equal(result.allOf[0].$id, '/schemas/core/foo.json');
    assert.equal(result.allOf[0].$schema, undefined);
  });
});

test('resolveRefs keeps parent $id on the deprecated-alias pattern', () => {
  // signal-pricing-option.json's pattern: { $id, $ref, ...sibling annotations }.
  // The alias's identity must win over the target's, otherwise the alias is
  // indistinguishable from the target after bundling.
  withSourceTree({
    'core/target.json': {
      $id: '/schemas/core/target.json',
      type: 'object',
      properties: { canonical: { type: 'string' } },
    },
  }, (sourceDir) => {
    const alias = {
      $id: '/schemas/core/alias.json',
      title: 'Alias',
      $ref: '/schemas/core/target.json',
    };
    const result = resolveRefs(clone(alias), sourceDir);
    assert.equal(result.$id, '/schemas/core/alias.json', 'alias $id must win over target $id');
    assert.equal(result.title, 'Alias');
    assert.ok(result.properties.canonical, 'target properties should still be inlined');
  });
});

test('resolveRefs preserves sibling fields after $ref inlining', () => {
  // The $ref + sibling-description pattern (e.g. core/deployment.json:27-30)
  // must not lose the sibling description to the inlined schema's description.
  withSourceTree({
    'core/foo.json': {
      $id: '/schemas/core/foo.json',
      description: 'Inner description',
      type: 'object',
    },
  }, (sourceDir) => {
    const parent = {
      properties: {
        x: {
          $ref: '/schemas/core/foo.json',
          description: 'Outer description (overrides inner)',
        },
      },
    };
    const result = resolveRefs(clone(parent), sourceDir);
    assert.equal(result.properties.x.$id, '/schemas/core/foo.json');
    assert.equal(result.properties.x.description, 'Outer description (overrides inner)');
  });
});

test('versionInlineSchemaIds stamps inner $ids and skips the root', () => {
  const schema = {
    $id: '/schemas/core/root.json',
    properties: {
      a: { $id: '/schemas/core/a.json' },
      b: {
        items: { $id: '/schemas/core/b.json' },
      },
    },
  };
  versionInlineSchemaIds(schema, '3.1.0');
  assert.equal(schema.$id, '/schemas/core/root.json', 'root $id is left for the bundled-prefix rewrite');
  assert.equal(schema.properties.a.$id, '/schemas/3.1.0/core/a.json');
  assert.equal(schema.properties.b.items.$id, '/schemas/3.1.0/core/b.json');
});

test('versionInlineSchemaIds is idempotent on already-versioned $ids', () => {
  // The guard `!value.startsWith('/schemas/{version}/')` prevents
  // double-stamping when the post-pass runs twice (e.g., dev rebuild after
  // a successful release build).
  const schema = {
    $id: '/schemas/core/root.json',
    properties: {
      a: { $id: '/schemas/3.1.0/core/a.json' },
    },
  };
  versionInlineSchemaIds(schema, '3.1.0');
  assert.equal(schema.properties.a.$id, '/schemas/3.1.0/core/a.json', 'already-versioned $id must not double-stamp');
});

test('versionInlineSchemaIds leaves non-/schemas/ $ids alone', () => {
  // A relative or external $id is the consumer's responsibility — the
  // bundler must not rewrite anything outside the spec's own URI space.
  const schema = {
    $id: '/schemas/core/root.json',
    properties: {
      a: { $id: 'https://example.com/external.json' },
      b: { $id: '#local-ref' },
    },
  };
  versionInlineSchemaIds(schema, '3.1.0');
  assert.equal(schema.properties.a.$id, 'https://example.com/external.json');
  assert.equal(schema.properties.b.$id, '#local-ref');
});

test('versionInlineSchemaIds walks array members with isRoot=false', () => {
  // The isRoot flag must not leak through array recursion — every array
  // member is a non-root, even if the array sits at the document root.
  const schema = {
    $id: '/schemas/core/root.json',
    oneOf: [
      { $id: '/schemas/core/branch-a.json' },
      { $id: '/schemas/core/branch-b.json' },
    ],
  };
  versionInlineSchemaIds(schema, '3.1.0');
  assert.equal(schema.$id, '/schemas/core/root.json', 'document root $id stays unstamped');
  assert.equal(schema.oneOf[0].$id, '/schemas/3.1.0/core/branch-a.json');
  assert.equal(schema.oneOf[1].$id, '/schemas/3.1.0/core/branch-b.json');
});
