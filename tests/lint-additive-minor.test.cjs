#!/usr/bin/env node

'use strict';

/**
 * Tests for scripts/lint-additive-minor.cjs.
 *
 * Single-fault rule: every comparison case starts from one valid fixture
 * tree, applies exactly one change to the candidate, and asserts the exact
 * set of findings. An unchanged copy of the fixture must produce none.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  NOTICE_KINDS,
  VIOLATION_KINDS,
  analyze,
  buildTree,
  checkAgainstBaseline,
  compareTrees,
  defaultBaseVersion,
  findingKey,
  historyPairs,
  lintAdditiveMinor,
  recordedCorrections,
} = require('../scripts/lint-additive-minor.cjs');

/** A small, valid schema tree. Each test clones it and changes one thing. */
function fixture() {
  return {
    'core/closed.json': {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: '/schemas/core/closed.json',
      type: 'object',
      properties: {
        id: { type: 'string', pattern: '^[a-z]+$' },
        count: { type: 'integer', minimum: 0, maximum: 10 },
        status: { $ref: '/schemas/enums/status.json' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    'core/open.json': {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: '/schemas/core/open.json',
      type: 'object',
      properties: {
        version: { type: 'string', const: '1' },
        note: { type: ['string', 'null'] },
        tags: { type: 'array', items: { type: 'string' } },
        preview: {
          'x-status': 'experimental',
          type: 'object',
          properties: { mode: { type: 'string' } },
          additionalProperties: false,
        },
      },
    },
    'core/explicit-open.json': {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: '/schemas/core/explicit-open.json',
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: true,
    },
    'core/union.json': {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: '/schemas/core/union.json',
      oneOf: [
        {
          type: 'object',
          properties: { kind: { const: 'a' }, a: { type: 'string' } },
          required: ['kind'],
          additionalProperties: false,
        },
        {
          type: 'object',
          properties: { kind: { const: 'b' }, b: { type: 'number' } },
          required: ['kind'],
          additionalProperties: false,
        },
      ],
    },
    'core/scalar.json': {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: '/schemas/core/scalar.json',
      anyOf: [
        { type: 'string', maxLength: 10 },
        { type: 'integer', minimum: 0 },
        { type: 'boolean' },
      ],
    },
    'core/composed.json': {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: '/schemas/core/composed.json',
      type: 'object',
      definitions: {
        keyed: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
      },
      allOf: [{ $ref: '#/definitions/keyed' }],
      properties: { key: { type: 'string' } },
    },
    'core/branched.json': {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: '/schemas/core/branched.json',
      type: 'object',
      properties: { mode: { type: 'string' } },
      required: ['mode'],
      oneOf: [
        { properties: { mode: { const: 'x' } } },
        { properties: { mode: { const: 'y' } } },
      ],
    },
    'enums/status.json': {
      $schema: 'http://json-schema.org/draft-07/schema#',
      $id: '/schemas/enums/status.json',
      type: 'string',
      enum: ['active', 'paused'],
    },
  };
}

function tree(label, files) {
  return buildTree(label, new Map(Object.entries(files)));
}

function writeTree(directory, files) {
  for (const [relativePath, schema] of Object.entries(files)) {
    fs.mkdirSync(path.join(directory, path.dirname(relativePath)), { recursive: true });
    fs.writeFileSync(path.join(directory, relativePath), JSON.stringify(schema));
  }
}

/** Every JSON file under `directory`, as [relative path, text]. */
function walk(directory, root = directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return walk(full, root);
    return entry.name.endsWith('.json') ? [[path.relative(root, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8')]] : [];
  });
}

/** Applies one change to a copy of the fixture and returns every finding. */
function findingsAfter(change) {
  const base = fixture();
  const candidate = fixture();
  change(candidate);
  return compareTrees(tree('base', base), tree('candidate', candidate)).findings;
}

test('an unchanged copy of the fixture produces no findings', () => {
  assert.deepEqual(findingsAfter(() => {}), []);
});

// ---------------------------------------------------------------------------
// One case per violation kind
// ---------------------------------------------------------------------------

const VIOLATION_CASES = [
  {
    kind: 'property-added-to-closed',
    change: (t) => { t['core/closed.json'].properties.extra = { type: 'string' }; },
    expected: { file: 'core/closed.json', pointer: '', detail: 'property extra added' },
  },
  {
    kind: 'property-removed',
    change: (t) => { delete t['core/open.json'].properties.note; },
    expected: { file: 'core/open.json', pointer: '', detail: 'property note removed' },
  },
  {
    kind: 'required-added',
    change: (t) => { t['core/closed.json'].required = ['id', 'count']; },
    expected: { file: 'core/closed.json', pointer: '', detail: 'property count newly required' },
  },
  {
    kind: 'type-narrowed',
    change: (t) => { t['core/open.json'].properties.note.type = 'string'; },
    expected: { file: 'core/open.json', pointer: '/properties/note', detail: 'type null|string → string' },
  },
  {
    kind: 'enum-value-removed',
    change: (t) => { t['enums/status.json'].enum = ['active']; },
    expected: { file: 'enums/status.json', pointer: '', detail: 'value "paused" removed' },
  },
  {
    kind: 'const-changed',
    change: (t) => { t['core/open.json'].properties.version.const = '2'; },
    expected: { file: 'core/open.json', pointer: '/properties/version', detail: 'const "1" → "2"' },
  },
  {
    kind: 'bound-tightened',
    change: (t) => { t['core/closed.json'].properties.count.minimum = 1; },
    expected: { file: 'core/closed.json', pointer: '/properties/count', detail: 'minimum 0 → 1' },
  },
  {
    kind: 'additional-properties-closed',
    change: (t) => { t['core/open.json'].additionalProperties = false; },
    expected: { file: 'core/open.json', pointer: '', detail: 'additionalProperties absent → false' },
  },
  {
    kind: 'file-removed',
    change: (t) => { delete t['core/explicit-open.json']; },
    expected: { file: 'core/explicit-open.json', pointer: '', detail: 'schema core/explicit-open.json removed' },
  },
];

test('every violation kind has a case', () => {
  assert.deepEqual(VIOLATION_CASES.map(({ kind }) => kind).sort(), [...VIOLATION_KINDS].sort());
});

for (const { kind, change, expected } of VIOLATION_CASES) {
  test(`flags ${kind}`, () => {
    assert.deepEqual(findingsAfter(change), [{ ...expected, kind }]);
  });
}

test('reads closure from the base, so opening an object while adding a property still fails', () => {
  const findings = findingsAfter((t) => {
    t['core/closed.json'].additionalProperties = true;
    t['core/closed.json'].properties.extra = { type: 'string' };
  });
  assert.deepEqual(findings.map((f) => [f.kind, f.detail]), [['property-added-to-closed', 'property extra added']]);
});

test('treats unevaluatedProperties: false as closed', () => {
  const base = fixture();
  base['core/explicit-open.json'].unevaluatedProperties = false;
  const candidate = fixture();
  candidate['core/explicit-open.json'].unevaluatedProperties = false;
  candidate['core/explicit-open.json'].properties.extra = { type: 'string' };
  const { findings } = compareTrees(tree('base', base), tree('candidate', candidate));
  assert.deepEqual(findings.map((f) => f.kind), ['property-added-to-closed']);
});

// ---------------------------------------------------------------------------
// Closed anywhere in the major (DR-0036)
// ---------------------------------------------------------------------------

/**
 * Compares a candidate with the fixture as base, where one earlier stable
 * release published core/explicit-open.json closed with only `name`.
 */
function analyzeWithEarlierClosure(change, { correctionsValue, candidateVersion = '3.3.0-beta.0', earlier } = {}) {
  const older = fixture();
  older['core/explicit-open.json'].additionalProperties = false;
  if (earlier) earlier(older);
  const candidate = fixture();
  change(candidate);
  return analyze({
    base: '3.2.7',
    baseTree: tree('3.2.7', fixture()),
    candTree: tree('source', candidate),
    candidateVersion,
    earlierTrees: [{ version: '3.0.4', tree: tree('3.0.4', older) }],
    correctionsValue,
    repoRoot: fixtureRoot(),
  });
}

test('an unchanged copy produces no findings when an earlier release closed a schema', () => {
  const result = analyzeWithEarlierClosure(() => {});
  assert.deepEqual([result.findings, result.notices, result.errors], [[], [], []]);
});

test('flags a property added to a schema an earlier release closed and the base leaves open', () => {
  const { findings } = analyzeWithEarlierClosure((t) => { t['core/explicit-open.json'].properties.extra = { type: 'string' }; });
  assert.deepEqual(findings, [{
    file: 'core/explicit-open.json',
    pointer: '',
    kind: 'property-added-to-closed',
    detail: 'property extra added (closed in 3.0.4)',
  }]);
});

test('marks a property the base already has, added after the earlier closure, as released', () => {
  const base = fixture();
  base['core/explicit-open.json'].properties.shipped = { type: 'string' };
  const older = fixture();
  older['core/explicit-open.json'].additionalProperties = false;
  const result = analyze({
    base: '3.2.7',
    baseTree: tree('3.2.7', base),
    candTree: tree('source', base),
    candidateVersion: '3.3.0-beta.0',
    earlierTrees: [{ version: '3.0.4', tree: tree('3.0.4', older) }],
  });
  assert.deepEqual(result.findings, [{
    file: 'core/explicit-open.json',
    pointer: '',
    kind: 'property-added-to-closed',
    detail: 'property shipped added (closed in 3.0.4)',
    released: true,
  }]);
});

test('names the last earlier release that published the schema closed', () => {
  const first = fixture();
  first['core/explicit-open.json'].additionalProperties = false;
  const second = fixture();
  second['core/explicit-open.json'].additionalProperties = false;
  const candidate = fixture();
  candidate['core/explicit-open.json'].properties.extra = { type: 'string' };
  const { findings } = analyze({
    base: '3.2.7',
    baseTree: tree('3.2.7', fixture()),
    candTree: tree('source', candidate),
    candidateVersion: '3.3.0-beta.0',
    earlierTrees: [{ version: '3.0.0', tree: tree('3.0.0', first) }, { version: '3.0.4', tree: tree('3.0.4', second) }],
  });
  assert.deepEqual(findings.map((f) => f.detail), ['property extra added (closed in 3.0.4)']);
});

test('keys an earlier closure on the node a $ref now reaches, not on the referring file', () => {
  // The earlier release closed an inline object; the base replaced it with a
  // $ref to a shared open schema. The shared schema inherits the closure.
  const older = fixture();
  older['core/open.json'].properties.area = {
    type: 'object',
    properties: { zip: { type: 'boolean' } },
    additionalProperties: false,
  };
  const base = fixture();
  base['core/area.json'] = {
    $id: '/schemas/core/area.json',
    type: 'object',
    properties: { zip: { type: 'boolean' } },
  };
  base['core/open.json'].properties.area = { $ref: '/schemas/core/area.json' };
  const candidate = JSON.parse(JSON.stringify(base));
  candidate['core/area.json'].properties.US = { type: 'array' };
  const { findings } = analyze({
    base: '3.2.7',
    baseTree: tree('3.2.7', base),
    candTree: tree('source', candidate),
    candidateVersion: '3.3.0-beta.0',
    earlierTrees: [{ version: '3.0.28', tree: tree('3.0.28', older) }],
  });
  assert.deepEqual(findings, [{
    file: 'core/area.json',
    pointer: '',
    kind: 'property-added-to-closed',
    detail: 'property US added (closed in 3.0.28)',
  }]);
});

test('an earlier release that marked the schema experimental does not close it', () => {
  const { findings } = analyzeWithEarlierClosure(
    (t) => { t['core/explicit-open.json'].properties.extra = { type: 'string' }; },
    { earlier: (t) => { t['core/explicit-open.json']['x-status'] = 'experimental'; } },
  );
  assert.deepEqual(findings, []);
});

// ---------------------------------------------------------------------------
// Notices
// ---------------------------------------------------------------------------

test('every notice kind has a case', () => {
  assert.deepEqual([...NOTICE_KINDS], ['additional-properties-opened']);
});

test('reports opening a closed schema as a notice, not a violation', () => {
  const { findings, notices } = compareTrees(tree('base', fixture()), tree('candidate', (() => {
    const t = fixture();
    t['core/closed.json'].additionalProperties = true;
    return t;
  })()));
  assert.deepEqual(findings, []);
  assert.deepEqual(notices, [{
    file: 'core/closed.json',
    pointer: '',
    kind: 'additional-properties-opened',
    detail: 'additionalProperties false → true',
  }]);
});

test('an opened schema in the CI check passes and reports the notice', () => {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'additive-minor-'));
  try {
    const candidate = fixture();
    delete candidate['core/closed.json'].additionalProperties;
    writeTree(sourceDir, candidate);
    const result = lintAdditiveMinor({
      sourceDir,
      baseTree: tree('fixture', fixture()),
      baseVersion: '3.2.7',
      candidateVersion: '3.3.0-beta.0',
      baselineValue: { base: '3.2.7', entries: [] },
      correctionsValue: { corrections: [] },
    });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(result.notices.map((n) => n.detail), ['additionalProperties false → absent']);
  } finally {
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Corrections
// ---------------------------------------------------------------------------

// A repository root for correction fixtures: one source text and one decision
// record whose correction tables list the fixture corrections.
const FIXTURE_DECISION = 'DR-9001';
const FIXTURE_SOURCE = { path: 'docs/rule.md', quote: 'Roots and containers stay open.' };
let fixtureRootPath = null;

function fixtureRoot() {
  if (fixtureRootPath) return fixtureRootPath;
  fixtureRootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'additive-minor-root-'));
  fs.mkdirSync(path.join(fixtureRootPath, 'docs'));
  // The quote wraps across a line break, as prose in the repository does.
  fs.writeFileSync(path.join(fixtureRootPath, FIXTURE_SOURCE.path), '# Rule\n\nRoots and containers\nstay open.\n');
  fs.mkdirSync(path.join(fixtureRootPath, 'governance', 'decisions'), { recursive: true });
  fs.writeFileSync(path.join(fixtureRootPath, 'governance', 'decisions', `${FIXTURE_DECISION}-fixture.md`), [
    '## Decision',
    '',
    '### Corrections',
    '',
    '#### (a) Reopen the fixture schemas',
    '',
    '| Schema | Pointer | Property | Reason |',
    '|---|---|---|---|',
    '| `core/closed.json` | root | `*` | A root. |',
    '| `core/explicit-open.json` | root | `*` | A root. |',
    '| `core/union.json` | `/oneOf/0`, `/oneOf/1` | `*` | Response branches. |',
    '| `core/closed.json` | `/properties/missing` | `*` | A location no schema has. |',
    '',
    '#### (b) Declare one property',
    '',
    '| Schema | Pointer | Property | Reason |',
    '|---|---|---|---|',
    '| `core/closed.json` | root | `extra` | Required by the rule. |',
    '',
    '#### (c) Tighten one bound',
    '',
    '| Schema | Pointer | Bound | Reason |',
    '|---|---|---|---|',
    '| `core/closed.json` | `/properties/id` | `minLength: 1` | The rule names an identifier. |',
    '',
    '## Rationale',
    '',
    '| `core/open.json` | root | `*` | Outside the corrections section. |',
    '',
  ].join('\n'));
  return fixtureRootPath;
}

test.after(() => {
  if (fixtureRootPath) fs.rmSync(fixtureRootPath, { recursive: true, force: true });
});

/** One correction entry, valid in the fixture root. */
function correction(overrides = {}) {
  return {
    file: 'core/closed.json',
    pointer: '',
    property: '*',
    release: '3.3.0',
    source: { ...FIXTURE_SOURCE },
    reason: 'Closed against the rule.',
    ...overrides,
  };
}

function corrections(...entries) {
  return { decision: FIXTURE_DECISION, corrections: entries };
}

/** Opens core/closed.json and adds a property, the change a reopening allows. */
function reopenAndAdd(t) {
  t['core/closed.json'].additionalProperties = true;
  t['core/closed.json'].properties.extra = { type: 'string' };
}

function analyzePair(change, { correctionsValue, candidateVersion = '3.3.0-beta.0' } = {}) {
  const candidate = fixture();
  change(candidate);
  return analyze({
    base: '3.2.7',
    baseTree: tree('3.2.7', fixture()),
    candTree: tree('source', candidate),
    candidateVersion,
    earlierTrees: [],
    correctionsValue,
    repoRoot: fixtureRoot(),
  });
}

test('a listed reopening accepts additions from its release on', () => {
  const result = analyzePair(reopenAndAdd, { correctionsValue: corrections(correction()) });
  assert.deepEqual([result.findings, result.errors], [[], []]);
  assert.deepEqual(result.notices.map((n) => [n.detail, n.corrected]), [['additionalProperties false → true', true]]);
});

test('a listed reopening accepts no additions before its release', () => {
  const result = analyzePair(reopenAndAdd, { correctionsValue: corrections(correction()), candidateVersion: '3.2.8' });
  assert.deepEqual(result.findings.map((f) => [f.kind, f.detail]), [['property-added-to-closed', 'property extra added']]);
});

test('a listed property correction accepts that property on a closed schema', () => {
  const result = analyzePair(
    (t) => { t['core/closed.json'].properties.extra = { type: 'string' }; },
    { correctionsValue: corrections(correction({ property: 'extra' })) },
  );
  assert.deepEqual([result.findings, result.notices, result.errors], [[], [], []]);
});

test('an addition next to a listed property correction still fails', () => {
  const result = analyzePair(
    (t) => {
      t['core/closed.json'].properties.extra = { type: 'string' };
      t['core/closed.json'].properties.other = { type: 'string' };
    },
    { correctionsValue: corrections(correction({ property: 'extra' })) },
  );
  assert.deepEqual(result.findings.map((f) => [f.file, f.detail]), [['core/closed.json', 'property other added']]);
  assert.deepEqual(result.errors, []);
});

/** A bound correction entry: core/closed.json's id gains minLength 1. */
function boundCorrection(overrides = {}) {
  const { property: _property, ...entry } = correction({ pointer: '/properties/id', bound: 'minLength', value: 1 });
  return { ...entry, ...overrides };
}

test('a listed bound correction accepts exactly that tightening', () => {
  const result = analyzePair(
    (t) => { t['core/closed.json'].properties.id.minLength = 1; },
    { correctionsValue: corrections(boundCorrection()) },
  );
  assert.deepEqual([result.findings, result.notices, result.errors], [[], [], []]);
});

test('an unrecorded tightening still fails', () => {
  const result = analyzePair((t) => { t['core/closed.json'].properties.id.minLength = 1; });
  assert.deepEqual(result.findings.map((f) => [f.file, f.pointer, f.kind, f.detail]),
    [['core/closed.json', '/properties/id', 'bound-tightened', 'minLength 1 added']]);
});

test('a bound correction admits no other value or bound', () => {
  const tighter = analyzePair(
    (t) => { t['core/closed.json'].properties.id.minLength = 2; },
    { correctionsValue: corrections(boundCorrection()) },
  );
  assert.deepEqual(tighter.findings.map((f) => f.detail), ['minLength 2 added']);
  const other = analyzePair(
    (t) => {
      t['core/closed.json'].properties.id.minLength = 1;
      t['core/closed.json'].properties.count.maximum = 5;
    },
    { correctionsValue: corrections(boundCorrection()) },
  );
  assert.deepEqual(other.findings.map((f) => [f.pointer, f.detail]), [['/properties/count', 'maximum 10 → 5']]);
});

test('fails when a bound correction is not applied in the candidate', () => {
  const result = analyzePair(() => {}, { correctionsValue: corrections(boundCorrection()) });
  assert.deepEqual(result.errors, ['correction core/closed.json#/properties/id does not carry minLength: 1 in source']);
});

test('fails when a bound correction is missing from its decision record', () => {
  const result = analyzePair(
    (t) => { t['core/closed.json'].properties.id.maxLength = 64; },
    { correctionsValue: corrections(boundCorrection({ bound: 'maxLength', value: 64 })) },
  );
  assert.deepEqual(result.errors, [`correction core/closed.json#/properties/id maxLength: 64 is not in the correction tables of ${FIXTURE_DECISION}-fixture.md`]);
});

test('an addition to a schema no correction names still fails', () => {
  const result = analyzePair(reopenAndAdd, {
    correctionsValue: corrections(correction({ file: 'core/explicit-open.json' })),
  });
  assert.deepEqual(result.findings.map((f) => [f.file, f.detail]), [['core/closed.json', 'property extra added']]);
});

test('a listed reopening applies to a schema an earlier release closed', () => {
  const result = analyzeWithEarlierClosure(
    (t) => { t['core/explicit-open.json'].properties.extra = { type: 'string' }; },
    { correctionsValue: corrections(correction({ file: 'core/explicit-open.json' })) },
  );
  assert.deepEqual([result.findings, result.errors], [[], []]);
});

test('a listed reopening covers each oneOf branch it names', () => {
  const result = analyzePair(
    (t) => {
      for (const branch of t['core/union.json'].oneOf) {
        branch.additionalProperties = true;
        branch.properties.extra = { type: 'string' };
      }
    },
    {
      correctionsValue: corrections(
        correction({ file: 'core/union.json', pointer: '/oneOf/0' }),
        correction({ file: 'core/union.json', pointer: '/oneOf/1' }),
      ),
    },
  );
  assert.deepEqual([result.findings, result.errors], [[], []]);
});

test('fails when a reopened schema is still closed in the candidate', () => {
  const result = analyzePair(() => {}, { correctionsValue: corrections(correction()) });
  assert.deepEqual(result.errors, ['correction core/closed.json# reopens a schema that is still closed in source']);
});

test('fails when a correction names a location that does not exist', () => {
  const result = analyzePair(() => {}, {
    correctionsValue: corrections(correction({ pointer: '/properties/missing' })),
  });
  assert.deepEqual(result.errors, ['correction core/closed.json#/properties/missing does not exist in source']);
});

test('fails when a property correction is not declared in the candidate', () => {
  const result = analyzePair(() => {}, { correctionsValue: corrections(correction({ property: 'extra' })) });
  assert.deepEqual(result.errors, ['correction core/closed.json# does not declare extra in source']);
});

test('every correction needs a stable release', () => {
  const result = analyzePair(reopenAndAdd, { correctionsValue: corrections(correction({ release: '3.3.0-beta.0' })) });
  assert.deepEqual(result.errors, ['corrections[0].release must be a stable release']);
});

test('every correction needs a reason', () => {
  const result = analyzePair(reopenAndAdd, { correctionsValue: corrections(correction({ reason: '' })) });
  assert.deepEqual(result.errors, ['corrections[0].reason must not be empty']);
});

test('every correction names a property', () => {
  const result = analyzePair(reopenAndAdd, { correctionsValue: corrections(correction({ property: undefined })) });
  assert.deepEqual(result.errors, ['corrections[0].property must be a string']);
});

test('every correction needs a source with a path and a quote', () => {
  const result = analyzePair(reopenAndAdd, {
    correctionsValue: corrections(correction({ source: { path: FIXTURE_SOURCE.path } })),
  });
  assert.deepEqual(result.errors, ['corrections[0].source must name a path and a quote']);
});

test('fails when a correction source file does not exist', () => {
  const result = analyzePair(reopenAndAdd, {
    correctionsValue: corrections(correction({ source: { ...FIXTURE_SOURCE, path: 'docs/missing.md' } })),
  });
  assert.deepEqual(result.errors, ['corrections[0].source.path docs/missing.md does not exist']);
});

test('fails when a correction source path names a directory', () => {
  const result = analyzePair(reopenAndAdd, {
    correctionsValue: corrections(correction({ source: { ...FIXTURE_SOURCE, path: 'docs' } })),
  });
  assert.deepEqual(result.errors, ['corrections[0].source.path docs does not exist']);
});

test('fails when a correction source path leaves the repository', () => {
  const result = analyzePair(reopenAndAdd, {
    correctionsValue: corrections(correction({ source: { ...FIXTURE_SOURCE, path: '../rule.md' } })),
  });
  assert.deepEqual(result.errors, ['corrections[0].source.path ../rule.md does not exist']);
});

test('fails when a correction quote is not in its source file', () => {
  const result = analyzePair(reopenAndAdd, {
    correctionsValue: corrections(correction({ source: { ...FIXTURE_SOURCE, quote: 'Roots may close.' } })),
  });
  assert.deepEqual(result.errors, [`corrections[0].source.quote is not in ${FIXTURE_SOURCE.path}`]);
});

test('fails when a correction is missing from its decision record', () => {
  const result = analyzePair(
    (t) => { t['core/explicit-open.json'].properties.extra = { type: 'string' }; },
    { correctionsValue: corrections(correction({ file: 'core/explicit-open.json', property: 'extra' })) },
  );
  assert.deepEqual(result.errors, [
    `correction core/explicit-open.json# extra is not in the correction tables of ${FIXTURE_DECISION}-fixture.md`,
  ]);
});

test('a table outside the record\'s Corrections section does not record a correction', () => {
  const result = analyzePair(() => {}, { correctionsValue: corrections(correction({ file: 'core/open.json' })) });
  assert.deepEqual(result.errors, [
    `correction core/open.json# * is not in the correction tables of ${FIXTURE_DECISION}-fixture.md`,
  ]);
});

test('fails when the corrections list names no existing decision record', () => {
  const result = analyzePair(reopenAndAdd, {
    correctionsValue: { decision: 'DR-9002', corrections: [correction()] },
  });
  assert.deepEqual(result.errors, ['no decision record for DR-9002 under governance/decisions']);
});

test('the repository corrections list is valid', () => {
  const value = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'lint-additive-minor-corrections.json'), 'utf8'));
  assert.equal(value.decision, 'DR-0036');
  const sourceTree = buildTree('source', new Map(walk(path.join(__dirname, '..', 'static', 'schemas', 'source'))));
  const result = analyze({
    base: null,
    baseTree: sourceTree,
    candTree: sourceTree,
    candidateVersion: '9.9.9',
    earlierTrees: [],
    correctionsValue: value,
  });
  assert.deepEqual(result.errors, []);
});

test('the repository corrections list holds exactly the correction tables of DR-0036', () => {
  const root = path.join(__dirname, '..');
  const value = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'lint-additive-minor-corrections.json'), 'utf8'));
  const decisions = path.join(root, 'governance', 'decisions');
  const record = fs.readdirSync(decisions).find((name) => name.startsWith(`${value.decision}-`));
  const recorded = recordedCorrections(fs.readFileSync(path.join(decisions, record), 'utf8'));
  assert.ok(recorded.size > 0, `${record} has no correction tables`);
  const listed = value.corrections.map((entry) => `${entry.file}#${entry.pointer} ${entry.property}`);
  assert.deepEqual(listed.filter((key) => !recorded.has(key)), [], 'listed but not in the tables');
  assert.deepEqual([...recorded].filter((key) => !listed.includes(key)), [], 'in the tables but not listed');
});

// ---------------------------------------------------------------------------
// Additive changes pass
// ---------------------------------------------------------------------------

test('passes a property added to an open object', () => {
  assert.deepEqual(findingsAfter((t) => { t['core/open.json'].properties.extra = { type: 'string' }; }), []);
  assert.deepEqual(findingsAfter((t) => { t['core/explicit-open.json'].properties.extra = { type: 'integer' }; }), []);
});

test('passes a new schema file', () => {
  assert.deepEqual(findingsAfter((t) => {
    t['core/new.json'] = { $id: '/schemas/core/new.json', type: 'object', additionalProperties: false };
  }), []);
});

test('passes widening changes', () => {
  const widenings = [
    (t) => { t['enums/status.json'].enum.push('archived'); },
    (t) => { t['core/closed.json'].properties.count.maximum = 20; },
    (t) => { t['core/closed.json'].properties.count.type = 'number'; },
    (t) => { t['core/closed.json'].required = []; },
    (t) => { delete t['core/closed.json'].properties.id.pattern; },
    (t) => { t['core/closed.json'].additionalProperties = true; },
  ];
  widenings.forEach((change, index) => assert.deepEqual(findingsAfter(change), [], `widening #${index}`));
});

test('passes a name the base already required through an allOf entry', () => {
  assert.deepEqual(findingsAfter((t) => { t['core/composed.json'].required = ['key']; }), []);
});

test('passes a property an open schema moved into a nested allOf entry', () => {
  // core/protocol-envelope.json declares adcp_version through its allOf of
  // core/version-envelope.json, so a response that composes the envelope
  // still declares it.
  assert.deepEqual(findingsAfter((t) => {
    const { note } = t['core/open.json'].properties;
    delete t['core/open.json'].properties.note;
    t['core/open.json'].allOf = [{ $ref: '/schemas/core/outer.json' }];
    t['core/outer.json'] = {
      $id: '/schemas/core/outer.json',
      type: 'object',
      allOf: [{ $ref: '/schemas/core/inner.json' }],
      properties: { trace: { type: 'string' } },
    };
    t['core/inner.json'] = { $id: '/schemas/core/inner.json', type: 'object', properties: { note } };
  }), []);
});

test('passes a branch requiring a name its enclosing schema already required', () => {
  assert.deepEqual(findingsAfter((t) => { t['core/branched.json'].oneOf[0].required = ['mode']; }), []);
});

test('skips a base schema marked experimental', () => {
  assert.deepEqual(findingsAfter((t) => { t['core/open.json'].properties.preview.properties.extra = { type: 'string' }; }), []);
});

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

test('matches files by $id and ignores the version segment of $id and $ref', () => {
  const base = fixture();
  base['core/closed.json'].$id = 'https://adcontextprotocol.org/schemas/3.2.7/core/closed.json';
  base['core/closed.json'].properties.status.$ref = 'https://adcontextprotocol.org/schemas/3.2.7/enums/status.json';
  const { findings } = compareTrees(tree('base', base), tree('candidate', fixture()));
  assert.deepEqual(findings, []);
});

test('a file that moves but keeps its $id is not removed', () => {
  const candidate = fixture();
  candidate['legacy/explicit-open.json'] = candidate['core/explicit-open.json'];
  delete candidate['core/explicit-open.json'];
  const { findings } = compareTrees(tree('base', fixture()), tree('candidate', candidate));
  assert.deepEqual(findings, []);
});

test('compares the targets when a $ref changes', () => {
  const candidate = fixture();
  candidate['enums/status-v2.json'] = {
    $id: '/schemas/enums/status-v2.json',
    type: 'string',
    enum: ['active'],
  };
  candidate['core/closed.json'].properties.status.$ref = '/schemas/enums/status-v2.json';
  const { findings } = compareTrees(tree('base', fixture()), tree('candidate', candidate));
  assert.deepEqual(findings, [{
    file: 'core/closed.json',
    pointer: '/properties/status',
    kind: 'enum-value-removed',
    detail: 'value "paused" removed',
  }]);
});

test('matches oneOf branches by discriminator, not position', () => {
  const findings = findingsAfter((t) => { t['core/union.json'].oneOf.reverse(); });
  assert.deepEqual(findings, []);
});

test('a removed branch with no key is not paired with another branch', () => {
  assert.deepEqual(findingsAfter((t) => { t['core/scalar.json'].anyOf.shift(); }), []);
});

// ---------------------------------------------------------------------------
// Base selection and history
// ---------------------------------------------------------------------------

test('the default base is the latest stable release of the same major line', () => {
  const released = ['3.0.0', '3.1.29', '3.2.7', '3.3.0-beta.0', '2.5.3'];
  assert.equal(defaultBaseVersion('3.3.0-beta.0', released), '3.2.7');
  assert.equal(defaultBaseVersion('3.2.8', released), '3.2.7');
  assert.equal(defaultBaseVersion('3.2.7', released), '3.1.29');
  assert.equal(defaultBaseVersion('4.0.0-beta.1', released), null);
});

test('history chains first releases of each minor, the latest patch, the prerelease, and source', () => {
  const released = ['3.0.0', '3.0.1', '3.1.0', '3.1.2', '3.2.0-rc.1', '3.2.1', '3.2.4', '3.3.0-beta.0', '3.3.0-beta.1', '2.5.3'];
  const { pairs, patchLines } = historyPairs(released, 3);
  assert.deepEqual(pairs.map(({ base, candidate }) => `${base}→${candidate}`), [
    '3.0.0→3.1.0',
    '3.1.0→3.2.1',
    '3.2.1→3.2.4',
    '3.2.4→3.3.0-beta.1',
    '3.3.0-beta.1→source',
  ]);
  assert.deepEqual(patchLines.map(({ base, candidate }) => `${base}→${candidate}`), ['3.0.0→3.0.1', '3.1.0→3.1.2']);
});

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

const VIOLATION_A = { file: 'core/a.json', pointer: '', kind: 'property-added-to-closed', detail: 'property x added' };
const VIOLATION_B = { file: 'core/b.json', pointer: '', kind: 'required-added', detail: 'property y newly required' };

function entry(finding, reason = 'pending WG decision') {
  const { file, pointer, kind, detail } = finding;
  return { file, pointer, kind, detail, reason };
}

test('recorded violations pass', () => {
  const result = checkAgainstBaseline({
    base: '3.2.7',
    findings: [VIOLATION_A],
    baselineValue: { base: '3.2.7', entries: [entry(VIOLATION_A)] },
  });
  assert.equal(result.ok, true, result.errors.join('\n'));
});

test('a violation missing from the baseline fails', () => {
  const result = checkAgainstBaseline({
    base: '3.2.7',
    findings: [VIOLATION_A, VIOLATION_B],
    baselineValue: { base: '3.2.7', entries: [entry(VIOLATION_A)] },
  });
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [`new non-additive change: ${findingKey(VIOLATION_B)}`]);
});

test('a fixed violation leaves a stale entry that must be removed', () => {
  const result = checkAgainstBaseline({
    base: '3.2.7',
    findings: [],
    baselineValue: { base: '3.2.7', entries: [entry(VIOLATION_A)] },
  });
  assert.equal(result.ok, false);
  assert.match(result.errors[0], /^stale baseline entry: .*remove it from the baseline$/);
});

test('stale entries only warn after a release moves the base', () => {
  const result = checkAgainstBaseline({
    base: '3.3.0',
    findings: [],
    baselineValue: { base: '3.2.7', entries: [entry(VIOLATION_A)] },
  });
  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(result.warnings.length, 1);
});

test('the baseline only shrinks against the target branch', () => {
  const previousBaseline = { base: '3.2.7', entries: [entry(VIOLATION_A), entry(VIOLATION_B)] };
  const shrunk = checkAgainstBaseline({
    base: '3.2.7',
    findings: [VIOLATION_A],
    baselineValue: { base: '3.2.7', entries: [entry(VIOLATION_A, 'WG decision: ship in 3.3')] },
    previousBaseline,
  });
  assert.equal(shrunk.ok, true, shrunk.errors.join('\n'));

  const grown = checkAgainstBaseline({
    base: '3.2.7',
    findings: [VIOLATION_A, VIOLATION_B, { ...VIOLATION_B, detail: 'property z newly required' }],
    baselineValue: {
      base: '3.2.7',
      entries: [entry(VIOLATION_A), entry(VIOLATION_B), entry({ ...VIOLATION_B, detail: 'property z newly required' })],
    },
    previousBaseline,
  });
  assert.equal(grown.ok, false);
  assert.deepEqual(grown.errors, [`baseline grew: ${findingKey({ ...VIOLATION_B, detail: 'property z newly required' })} is not in the target branch baseline`]);
});

test('a released finding may enter the baseline; an unreleased one may not', () => {
  const released = { ...VIOLATION_A, detail: 'property x added (closed in 3.0.4)', released: true };
  const previousBaseline = { base: '3.2.7', entries: [] };
  const allowed = checkAgainstBaseline({
    base: '3.2.7',
    findings: [released],
    baselineValue: { base: '3.2.7', entries: [entry(released, 'shipped in 3.1.0')] },
    previousBaseline,
  });
  assert.equal(allowed.ok, true, allowed.errors.join('\n'));

  const unreleased = { ...released, released: undefined };
  const rejected = checkAgainstBaseline({
    base: '3.2.7',
    findings: [unreleased],
    baselineValue: { base: '3.2.7', entries: [entry(unreleased, 'shipped in 3.1.0')] },
    previousBaseline,
  });
  assert.deepEqual(rejected.errors, [`baseline grew: ${findingKey(unreleased)} is not in the target branch baseline`]);
});

test('every baseline entry needs a reason', () => {
  const result = checkAgainstBaseline({
    base: '3.2.7',
    findings: [VIOLATION_A],
    baselineValue: { base: '3.2.7', entries: [{ ...entry(VIOLATION_A), reason: ' ' }] },
  });
  assert.deepEqual(result.errors, ['baseline entries[0].reason must not be empty']);
});

test('every baseline entry needs a violation kind', () => {
  const unknown = { ...VIOLATION_A, kind: 'pattern-changed' };
  const result = checkAgainstBaseline({
    base: '3.2.7',
    findings: [unknown],
    baselineValue: { base: '3.2.7', entries: [entry(unknown)] },
  });
  assert.deepEqual(result.errors, ['baseline entries[0].kind pattern-changed is not a violation kind']);
});

test('the CI check reads a source directory and fails on a new violation', () => {
  const sourceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'additive-minor-'));
  try {
    const candidate = fixture();
    candidate['core/closed.json'].properties.extra = { type: 'string' };
    for (const [relativePath, schema] of Object.entries(candidate)) {
      fs.mkdirSync(path.join(sourceDir, path.dirname(relativePath)), { recursive: true });
      fs.writeFileSync(path.join(sourceDir, relativePath), JSON.stringify(schema));
    }
    const run = (entries) => lintAdditiveMinor({
      sourceDir,
      baseTree: tree('fixture', fixture()),
      baseVersion: '3.2.7',
      baselineValue: { base: '3.2.7', entries },
      correctionsValue: { corrections: [] },
    });
    const failing = run([]);
    assert.equal(failing.ok, false);
    assert.deepEqual(failing.added.map((f) => f.detail), ['property extra added']);
    const recorded = run([entry({ ...failing.added[0] })]);
    assert.equal(recorded.ok, true, recorded.errors.join('\n'));
  } finally {
    fs.rmSync(sourceDir, { recursive: true, force: true });
  }
});

test('the repository source passes against the recorded baseline', () => {
  const result = lintAdditiveMinor();
  assert.equal(result.ok, true, result.errors.join('\n'));
  if (!result.skipped) assert.ok(result.filesCompared > 500, 'expected the lint to see the released tree');
});
