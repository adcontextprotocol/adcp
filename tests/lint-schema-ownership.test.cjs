#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  collectRefs,
  findCycle,
  lintSchemaOwnership,
  loadSchemaRegistry,
  resolveRefTarget,
} = require('../scripts/lint-schema-ownership.cjs');

const OWNERSHIP = {
  shared: ['core/', 'enums/'],
  aggregations: ['core/everything.json'],
  domains: {
    media_buy: { paths: ['media-buy/'], may_depend_on: ['creative'] },
    creative: { paths: ['creative/'], may_depend_on: [] },
    signals: { paths: ['signals/'], may_depend_on: [] },
  },
  files: {},
};

function schema(relativePath, body = {}) {
  return { $id: `/schemas/${relativePath}`, type: 'object', ...body };
}

function ref(target) {
  return { $ref: `/schemas/${target}` };
}

function writeFixture(files) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-ownership-'));
  for (const [relativePath, body] of Object.entries(files)) {
    const file = path.join(tmp, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(schema(relativePath, body)));
  }
  return tmp;
}

function withFixture(files, options, callback) {
  const tmp = writeFixture(files);
  try {
    callback(lintSchemaOwnership({
      schemasDir: tmp,
      ownershipValue: options.ownership || OWNERSHIP,
      baselineValue: options.baseline || { entries: [] },
    }));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const BASE_FILES = {
  'core/everything.json': {},
  'core/id.json': {},
  'enums/kind.json': {},
  'creative/format.json': { properties: { id: ref('core/id.json') } },
  'signals/signal.json': {},
};

test('the repository source tree passes against the recorded baseline', () => {
  const result = lintSchemaOwnership();
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.ok(result.crossFileRefs > 1000, 'expected the lint to see the real ref graph');
});

test('allows shared, same-domain, and declared domain refs', () => {
  withFixture({
    ...BASE_FILES,
    'media-buy/product.json': {
      properties: {
        id: ref('core/id.json'),
        kind: ref('enums/kind.json'),
        format: ref('creative/format.json'),
        sibling: { $ref: './package.json' },
      },
    },
    'media-buy/package.json': {},
  }, {}, (result) => {
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.equal(result.crossings.length, 0);
  });
});

test('flags an undeclared domain dependency and shared → domain refs', () => {
  withFixture({
    ...BASE_FILES,
    'creative/uses-signal.json': { properties: { s: ref('signals/signal.json') } },
    'core/leaky.json': { properties: { f: ref('creative/format.json') } },
  }, {}, (result) => {
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.added.map(({ key, rule }) => `${rule}: ${key}`),
      [
        'shared-to-domain: core/leaky.json → creative/format.json',
        'undeclared-domain-dependency: creative/uses-signal.json → signals/signal.json',
      ],
    );
  });
});

test('a declared dependency only goes one way', () => {
  withFixture({
    ...BASE_FILES,
    'media-buy/product.json': {},
    'creative/back.json': { properties: { p: ref('media-buy/product.json') } },
  }, {}, (result) => {
    assert.deepEqual(result.added.map(({ key }) => key), ['creative/back.json → media-buy/product.json']);
  });
});

test('baseline entries suppress recorded crossings and go stale when fixed', () => {
  const files = {
    ...BASE_FILES,
    'creative/uses-signal.json': { properties: { s: ref('signals/signal.json') } },
  };
  const entry = {
    from: 'creative/uses-signal.json',
    to: 'signals/signal.json',
    rule: 'undeclared-domain-dependency',
  };
  withFixture(files, { baseline: { entries: [entry] } }, (result) => {
    assert.equal(result.ok, true, result.errors.join('\n'));
  });
  withFixture(BASE_FILES, { baseline: { entries: [entry] } }, (result) => {
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), /stale baseline entry: creative\/uses-signal\.json/);
  });
});

test('aggregation files may reference any domain', () => {
  withFixture({
    ...BASE_FILES,
    'core/everything.json': { oneOf: [ref('creative/format.json'), ref('signals/signal.json')] },
  }, {}, (result) => {
    assert.equal(result.ok, true, result.errors.join('\n'));
  });
});

test('file overrides move a shared file into a domain', () => {
  const ownership = { ...OWNERSHIP, files: { 'core/product-ish.json': 'media_buy' } };
  withFixture({
    ...BASE_FILES,
    'core/product-ish.json': { properties: { f: ref('creative/format.json') } },
  }, { ownership }, (result) => {
    assert.equal(result.ok, true, result.errors.join('\n'));
  });
});

test('every schema file needs an owner', () => {
  withFixture({ ...BASE_FILES, 'mystery/thing.json': {} }, {}, (result) => {
    assert.match(result.errors.join('\n'), /unowned schema file: mystery\/thing\.json/);
  });
});

test('rejects cycles, unknown domains, and reused paths in the ownership config', () => {
  const cyclic = {
    ...OWNERSHIP,
    domains: {
      ...OWNERSHIP.domains,
      creative: { paths: ['creative/'], may_depend_on: ['signals'] },
      signals: { paths: ['signals/'], may_depend_on: ['media_buy'] },
    },
  };
  withFixture(BASE_FILES, { ownership: cyclic }, (result) => {
    assert.match(result.errors.join('\n'), /cycle: creative → signals → media_buy → creative/);
  });
  const broken = {
    ...OWNERSHIP,
    domains: {
      ...OWNERSHIP.domains,
      signals: { paths: ['creative/'], may_depend_on: ['nope'] },
    },
  };
  withFixture(BASE_FILES, { ownership: broken }, (result) => {
    const errors = result.errors.join('\n');
    assert.match(errors, /already owned by creative/);
    assert.match(errors, /unknown domain nope/);
  });
});

test('collectRefs skips instance data but not properties that share its name', () => {
  const refs = collectRefs({
    examples: [{ $ref: '/schemas/creative/format.json' }],
    default: { $ref: '/schemas/creative/format.json' },
    properties: {
      examples: { type: 'array', items: { $ref: '/schemas/core/id.json' } },
      default: { $ref: '/schemas/enums/kind.json' },
    },
  });
  assert.deepEqual(refs.sort(), ['/schemas/core/id.json', '/schemas/enums/kind.json']);
});

test('findCycle returns null for a DAG', () => {
  const graph = new Map([
    ['a', new Set(['b', 'c'])],
    ['b', new Set(['c'])],
    ['c', new Set()],
  ]);
  assert.equal(findCycle(graph), null);
});

test('collectRefs reads a $ref on a property whose name is a schema keyword', () => {
  const refs = collectRefs({
    properties: {
      properties: { $ref: '/schemas/creative/format.json' },
      definitions: { type: 'object', examples: [{ $ref: '/schemas/not/a/ref.json' }] },
    },
  });
  assert.deepEqual(refs, ['/schemas/creative/format.json']);
});

test('resolveRefTarget normalizes every ref form the tree uses', () => {
  const tmp = writeFixture({ 'core/id.json': {}, 'media-buy/product.json': {} });
  try {
    const registry = loadSchemaRegistry(tmp);
    const from = 'media-buy/product.json';
    const cases = [
      ['/schemas/core/id.json', { target: 'core/id.json' }],
      ['/schemas/latest/core/id.json', { target: 'core/id.json' }],
      ['/schemas/v3/core/id.json', { target: 'core/id.json' }],
      ['/schemas/3.2.1/core/id.json#/definitions/x', { target: 'core/id.json' }],
      ['/schemas/3.3.0-beta.1/core/id.json', { target: 'core/id.json' }],
      ['https://adcontextprotocol.org/schemas/core/id.json', { target: 'core/id.json' }],
      ['http://www.adcontextprotocol.org/schemas/v3/core/id.json', { target: 'core/id.json' }],
      ['../core/id.json', { target: 'core/id.json' }],
      ['./product.json', { target: 'media-buy/product.json' }],
      ['#/definitions/local', null],
      ['https://json-schema.org/draft-07/schema', null],
      ['/schemas/core/missing.json', { unresolved: true }],
      ['https://adcontextprotocol.org/schemas/3.2.1/core/typo.json', { unresolved: true }],
    ];
    for (const [ref, expected] of cases) {
      assert.deepEqual(resolveRefTarget(ref, from, registry), expected, ref);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reports refs into the schema tree that match no file', () => {
  withFixture({
    ...BASE_FILES,
    'media-buy/product.json': { properties: { x: ref('core/typo.json') } },
  }, {}, (result) => {
    assert.match(result.errors.join('\n'), /unresolved \$ref: media-buy\/product\.json → \/schemas\/core\/typo\.json/);
  });
});

test('reports a $id that does not match its file path', () => {
  const tmp = writeFixture(BASE_FILES);
  try {
    fs.writeFileSync(
      path.join(tmp, 'signals/signal.json'),
      JSON.stringify({ $id: '/schemas/creative/format.json', type: 'object' }),
    );
    const result = lintSchemaOwnership({
      schemasDir: tmp,
      ownershipValue: OWNERSHIP,
      baselineValue: { entries: [] },
    });
    assert.match(result.errors.join('\n'), /signals\/signal\.json: \$id \/schemas\/creative\/format\.json does not match/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
