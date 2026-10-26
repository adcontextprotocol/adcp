#!/usr/bin/env node

'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadSchemaRegistry } = require('../scripts/lint-schema-ownership.cjs');
const {
  collectSites,
  detectSources,
  fingerprint,
  lintSchemaValueDomains,
} = require('../scripts/lint-schema-value-domains.cjs');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'lint-schema-value-domains.cjs');

function ref(target) {
  return { $ref: `/schemas/${target}` };
}

const MONEY_INLINE = {
  type: 'object',
  properties: {
    amount: { type: 'number', minimum: 0 },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
  },
  required: ['amount', 'currency'],
};

const DATE_RANGE = {
  type: 'object',
  properties: {
    start: { type: 'string', format: 'date' },
    end: { type: 'string', format: 'date' },
  },
  required: ['start', 'end'],
};

const TASK_SUBMITTED = {
  type: 'object',
  properties: {
    status: { type: 'string', const: 'submitted' },
    task_id: { type: 'string', minLength: 1 },
  },
  required: ['status', 'task_id'],
};

/**
 * A tree that passes: one money copy, one kernel task envelope, two ID
 * entities, and one timestamp, each listed where the inventory needs it.
 */
function baseFixture() {
  return {
    files: {
      'core/x-entity-types.json': {
        'x-entity-definitions': { creative: 'A creative.', media_buy: 'A media buy.' },
      },
      'core/task-submitted.json': TASK_SUBMITTED,
      'core/date-range.json': DATE_RANGE,
      'core/context.json': { type: 'object', additionalProperties: true },
      'core/ext.json': { type: 'object', additionalProperties: true },
      'creative/creative.json': {
        type: 'object',
        properties: { creative_id: { type: 'string', 'x-entity': 'creative' } },
      },
      'media-buy/create.json': {
        type: 'object',
        properties: {
          media_buy_id: { type: 'string', 'x-entity': 'media_buy' },
          budget: MONEY_INLINE,
          created_at: { type: 'string', format: 'date-time' },
          task: ref('core/task-submitted.json'),
        },
      },
    },
    inventory: {
      value_domains: {
        money: 'Money.',
        envelope: 'Envelopes.',
        identity: 'IDs.',
        time: 'Time.',
      },
      concepts: [
        {
          id: 'money',
          value_domain: 'money',
          meaning: 'An amount in one currency.',
          kernel_type: 'unnamed',
          match: { properties: ['amount', 'currency'] },
          sources: ['media-buy/create.json#/properties/budget'],
        },
        {
          id: 'task-submitted',
          value_domain: 'envelope',
          meaning: 'A task accepted to run asynchronously.',
          kernel_type: '/schemas/core/task-submitted.json',
          match: { properties: ['status', 'task_id'], const: { status: 'submitted' } },
          sources: [],
        },
        {
          id: 'record-id',
          value_domain: 'identity',
          meaning: 'The ID of a record.',
          kernel_type: 'unnamed',
          match: { 'x-entity': ['creative', 'media_buy'] },
          sources: [
            'creative/creative.json#/properties/creative_id',
            'media-buy/create.json#/properties/media_buy_id',
          ],
        },
        {
          id: 'timestamp',
          value_domain: 'time',
          meaning: 'An instant.',
          kernel_type: 'unnamed',
          match: { format: 'date-time' },
          sources: ['media-buy/create.json#/properties/created_at'],
        },
        {
          id: 'date-range',
          value_domain: 'time',
          meaning: 'A span between two calendar days.',
          kernel_type: '/schemas/core/date-range.json',
        },
        {
          id: 'context',
          value_domain: 'envelope',
          meaning: 'Caller data echoed back.',
          kernel_type: '/schemas/core/context.json',
        },
        {
          id: 'extension',
          value_domain: 'envelope',
          meaning: 'Implementation-specific fields.',
          kernel_type: '/schemas/core/ext.json',
        },
      ],
      homonyms: [],
      distinct_structures: [
        { types: ['/schemas/core/context.json', '/schemas/core/ext.json'], reason: 'Echoed versus read.' },
      ],
    },
    ownership: {
      shared: ['core/', 'enums/'],
      aggregations: [],
      domains: {
        media_buy: { paths: ['media-buy/'], may_depend_on: [] },
        creative: { paths: ['creative/'], may_depend_on: [] },
      },
      files: {},
    },
    baseline: { entries: [] },
  };
}

function run(fixture) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-value-domains-'));
  try {
    for (const [relativePath, body] of Object.entries(fixture.files)) {
      const file = path.join(tmp, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ $id: `/schemas/${relativePath}`, ...body }));
    }
    return lintSchemaValueDomains({
      schemasDir: tmp,
      inventoryValue: fixture.inventory,
      ownershipValue: fixture.ownership,
      baselineValue: fixture.baseline,
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function concept(fixture, id) {
  return fixture.inventory.concepts.find((entry) => entry.id === id);
}

function withChange(change) {
  const fixture = structuredClone(baseFixture());
  change(fixture);
  return fixture;
}

test('the base fixture passes', () => {
  const result = run(baseFixture());
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('the repository tree passes against its inventory and baseline', () => {
  const result = lintSchemaValueDomains();
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.ok(result.sourceCount > 1000, 'expected the lint to see the real inline sources');
});

// Known-bad fixtures. Each one introduces exactly one fault, and the lint
// must report exactly that fault.
const KNOWN_BAD = [
  {
    name: 'a concept with two kernel types',
    change: (f) => { concept(f, 'money').kernel_type = ['/schemas/core/context.json', 'unnamed']; },
    error: /money\): kernel_type must be exactly one schema \$id/,
  },
  {
    name: 'two concepts that share one kernel type',
    change: (f) => { concept(f, 'extension').kernel_type = '/schemas/core/context.json'; },
    error: /kernel_type \/schemas\/core\/context\.json already represents context/,
  },
  {
    name: 'a kernel type that is no schema file',
    change: (f) => { concept(f, 'context').kernel_type = '/schemas/core/nowhere.json'; },
    error: /kernel_type \/schemas\/core\/nowhere\.json is no schema file/,
  },
  {
    name: 'a value domain the inventory does not define',
    change: (f) => { concept(f, 'timestamp').value_domain = 'calendar'; },
    error: /value_domain calendar is not one of/,
  },
  {
    name: 'a concept with no meaning',
    change: (f) => { concept(f, 'money').meaning = ' '; },
    error: /money\): state its meaning/,
  },
  {
    name: 'a kernel type that reaches a domain schema through a shared file',
    change: (f) => {
      f.files['core/task-submitted.json'] = {
        ...TASK_SUBMITTED,
        properties: { ...TASK_SUBMITTED.properties, detail: ref('core/detail.json') },
      };
      f.files['core/detail.json'] = { type: 'object', properties: { buy: ref('media-buy/create.json') } };
    },
    error: /kernel type core\/task-submitted\.json \(task-submitted\) references media-buy\/create\.json, a media_buy schema/,
  },
  {
    name: 'a source whose site was removed',
    change: (f) => { delete f.files['media-buy/create.json'].properties.created_at; },
    error: /stale source: media-buy\/create\.json#\/properties\/created_at no longer declares timestamp inline/,
  },
  {
    name: 'a source whose site now references a schema',
    change: (f) => { f.files['media-buy/create.json'].properties.budget = ref('core/context.json'); },
    error: /stale source: media-buy\/create\.json#\/properties\/budget no longer declares money inline/,
  },
  {
    name: 'an inline copy the concept does not list',
    change: (f) => { f.files['creative/creative.json'].properties.updated_at = { type: 'string', format: 'date-time' }; },
    error: /new inline timestamp: creative\/creative\.json#\/properties\/updated_at declares the concept inline/,
  },
  {
    name: 'an inline copy of a named kernel type with a weaker constraint',
    change: (f) => {
      f.files['creative/creative.json'].properties.task = {
        type: 'object',
        properties: { status: { type: 'string', const: 'submitted' }, task_id: { type: 'string' } },
      };
    },
    error: /new inline task-submitted: creative\/creative\.json#\/properties\/task declares the concept inline; reference \/schemas\/core\/task-submitted\.json instead/,
  },
  {
    name: 'an x-entity no concept lists',
    change: (f) => { concept(f, 'record-id').match['x-entity'] = ['creative']; concept(f, 'record-id').sources.pop(); },
    error: /unmapped entity: x-entity media_buy is declared inline/,
  },
  {
    name: 'an x-entity two concepts list',
    change: (f) => {
      f.inventory.concepts.push({
        id: 'other-id',
        value_domain: 'identity',
        meaning: 'Another ID class.',
        kernel_type: 'unnamed',
        match: { 'x-entity': ['creative'] },
        sources: [],
      });
    },
    error: /x-entity creative already belongs to record-id/,
  },
  {
    name: 'an x-entity the registry does not define',
    change: (f) => { concept(f, 'record-id').match['x-entity'].push('ghost'); },
    error: /x-entity ghost is not registered in core\/x-entity-types\.json/,
  },
  {
    name: 'a property name that carries two meanings and is not a homonym',
    change: (f) => {
      f.files['creative/creative.json'].properties.creative_id = { type: 'string', 'x-entity': 'creative' };
      f.files['media-buy/create.json'].properties.creative_id = { type: 'string', 'x-entity': 'media_buy' };
      concept(f, 'record-id').sources.push('media-buy/create.json#/properties/creative_id');
    },
    error: /homonym: the property name creative_id carries 2 meanings/,
  },
  {
    name: 'a homonym whose name carries one meaning',
    change: (f) => { f.inventory.homonyms.push({ name: 'created_at', reason: 'Listed by mistake.' }); },
    error: /stale homonym: the property name created_at carries at most one meaning/,
  },
  {
    name: 'an inline structural twin of a kernel type',
    change: (f) => { f.files['creative/creative.json'].properties.flight = { ...DATE_RANGE, description: 'A copy.' }; },
    error: /new kernel-twin: creative\/creative\.json#\/properties\/flight = core\/date-range\.json/,
  },
  {
    name: 'a named structural twin of a kernel type',
    change: (f) => { f.files['core/flight-dates.json'] = { ...DATE_RANGE, title: 'Flight Dates' }; },
    error: /new kernel-twin: core\/flight-dates\.json# = core\/date-range\.json/,
  },
  {
    name: 'two named schemas with one structure',
    change: (f) => {
      f.files['enums/catalog-action.json'] = { type: 'string', enum: ['created', 'deleted'] };
      f.files['enums/creative-action.json'] = { type: 'string', enum: ['deleted', 'created'] };
    },
    error: /new named-twin: enums\/catalog-action\.json = enums\/creative-action\.json/,
  },
  {
    name: 'a distinct declaration whose schemas no longer share a structure',
    change: (f) => { f.files['core/ext.json'] = { type: 'object', additionalProperties: false }; },
    error: /stale distinct structure: core\/context\.json, core\/ext\.json no longer share exactly one structure/,
  },
  {
    name: 'a baseline entry whose twin no longer occurs',
    change: (f) => {
      f.baseline.entries.push({
        check: 'named-twin',
        types: ['enums/a.json', 'enums/b.json'],
        verdict: 'merge',
        reason: 'Fixed since.',
      });
    },
    error: /stale baseline entry: named-twin: enums\/a\.json = enums\/b\.json no longer occurs/,
  },
];

for (const { name, change, error } of KNOWN_BAD) {
  test(`fails on ${name}`, () => {
    const result = run(withChange(change));
    assert.equal(result.ok, false, `expected ${name} to fail`);
    assert.equal(result.errors.length, 1, result.errors.join('\n'));
    assert.match(result.errors[0], error);
  });
}

const TWIN_FILES = {
  'enums/catalog-action.json': { type: 'string', enum: ['created', 'deleted'] },
  'enums/creative-action.json': { type: 'string', enum: ['created', 'deleted'] },
};

function twinBaselineEntry(overrides = {}) {
  return {
    check: 'named-twin',
    types: ['enums/catalog-action.json', 'enums/creative-action.json'],
    verdict: 'merge',
    reason: 'One list of sync item actions.',
    ...overrides,
  };
}

test('a baseline entry with a verdict and a reason suppresses its twin', () => {
  const result = run(withChange((f) => {
    Object.assign(f.files, TWIN_FILES);
    f.baseline.entries.push(twinBaselineEntry());
  }));
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('a baseline verdict outside the closed set fails', () => {
  const result = run(withChange((f) => {
    Object.assign(f.files, TWIN_FILES);
    f.baseline.entries.push(twinBaselineEntry({ verdict: 'accepted' }));
  }));
  assert.deepEqual(result.errors, ['baseline entries[0].verdict must be one of: replace, merge, alias']);
});

test('a baseline entry without a reason fails', () => {
  const result = run(withChange((f) => {
    Object.assign(f.files, TWIN_FILES);
    f.baseline.entries.push(twinBaselineEntry({ reason: '' }));
  }));
  assert.deepEqual(result.errors, ['baseline entries[0]: state the reason']);
});

test('a distinct declaration with a reason suppresses a named twin', () => {
  const result = run(withChange((f) => {
    Object.assign(f.files, TWIN_FILES);
    f.inventory.distinct_structures.push({
      types: ['/schemas/enums/catalog-action.json', '/schemas/enums/creative-action.json'],
      reason: 'A receiver applies each to a different record.',
    });
  }));
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('a listed homonym with a reason passes', () => {
  const result = run(withChange((f) => {
    f.files['media-buy/create.json'].properties.creative_id = { type: 'string', 'x-entity': 'media_buy' };
    concept(f, 'record-id').sources.push('media-buy/create.json#/properties/creative_id');
    f.inventory.homonyms.push({ name: 'creative_id', reason: 'Two records share the name.' });
  }));
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('schemas that only reference another schema are aliases, not twins', () => {
  const result = run(withChange((f) => {
    f.files['media-buy/a-submitted.json'] = { allOf: [ref('core/task-submitted.json')] };
    f.files['media-buy/b-submitted.json'] = { allOf: [ref('core/task-submitted.json')] };
  }));
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('a kernel type that constrains only its type has no structural twins', () => {
  const result = run(withChange((f) => {
    f.files['creative/creative.json'].properties.notes = { type: 'object' };
  }));
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('a kernel type may reference shared schemas', () => {
  const result = run(withChange((f) => {
    f.files['core/task-submitted.json'] = {
      ...TASK_SUBMITTED,
      properties: { ...TASK_SUBMITTED.properties, context: ref('core/context.json') },
    };
  }));
  assert.equal(result.ok, true, result.errors.join('\n'));
});

function fingerprintOf(body, other = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-value-domains-fp-'));
  try {
    const files = { 'core/target.json': {}, 'media-buy/site.json': body, ...other };
    for (const [relativePath, schema] of Object.entries(files)) {
      const file = path.join(tmp, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(schema));
    }
    const registry = loadSchemaRegistry(tmp);
    return fingerprint(registry.byKey.get('media-buy/site.json').schema, 'media-buy/site.json', registry);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('fingerprints ignore annotations', () => {
  assert.equal(
    fingerprintOf({ type: 'string', title: 'A', description: 'B', examples: ['c'], 'x-entity': 'creative' }),
    fingerprintOf({ type: 'string' }),
  );
});

test('fingerprints ignore the order of set-valued keywords', () => {
  assert.equal(
    fingerprintOf({ type: 'object', required: ['a', 'b'], enum: [1, 2] }),
    fingerprintOf({ type: 'object', required: ['b', 'a'], enum: [2, 1] }),
  );
});

test('fingerprints treat additionalProperties: true as the default', () => {
  assert.equal(
    fingerprintOf({ type: 'object', additionalProperties: true }),
    fingerprintOf({ type: 'object' }),
  );
});

test('fingerprints resolve every spelling of a $ref to its file', () => {
  assert.equal(
    fingerprintOf({ $ref: '../core/target.json' }),
    fingerprintOf({ $ref: '/schemas/3.2.1/core/target.json' }),
  );
});

test('fingerprints keep constraints that differ', () => {
  assert.notEqual(
    fingerprintOf({ type: 'string', minLength: 1 }),
    fingerprintOf({ type: 'string' }),
  );
});

test('collectSites visits subschemas but not instance data', () => {
  const registry = { documents: [{ relativePath: 'core/a.json', schema: {
    properties: { a: { items: { type: 'string' } } },
    examples: [{ properties: { b: {} } }],
    default: { type: 'object' },
  } }] };
  assert.deepEqual(
    collectSites(registry).map((site) => site.pointer),
    ['', '/properties/a', '/properties/a/items'],
  );
});

test('detectSources lists what each match rule finds, without the kernel type', () => {
  const fixture = baseFixture();
  fixture.files['enums/task-copy.json'] = { type: 'object', properties: TASK_SUBMITTED.properties };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-value-domains-detect-'));
  try {
    for (const [relativePath, body] of Object.entries(fixture.files)) {
      const file = path.join(tmp, relativePath);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(body));
    }
    const detected = detectSources(fixture.inventory, loadSchemaRegistry(tmp));
    assert.deepEqual(detected.get('task-submitted'), ['enums/task-copy.json#']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('--update-sources refuses to run without its environment variable', () => {
  const env = { ...process.env };
  delete env.ADCP_UPDATE_SCHEMA_VALUE_DOMAINS;
  const result = spawnSync(process.execPath, [SCRIPT, '--update-sources'], { env, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Refusing to rewrite inventory sources/);
});
