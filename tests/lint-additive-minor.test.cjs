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
  PENDING_REASON,
  VIOLATION_KINDS,
  buildTree,
  checkAgainstBaseline,
  compareTrees,
  defaultBaseVersion,
  findingKey,
  historyPairs,
  lintAdditiveMinor,
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
        label: { type: 'string', minLength: 1, maxLength: 50 },
        homepage: { type: 'string', format: 'uri' },
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

/** Applies one change to a copy of the fixture and returns every finding. */
function findingsAfter(change) {
  const base = fixture();
  const candidate = fixture();
  change(candidate);
  return compareTrees(tree('base', base), tree('candidate', candidate)).findings;
}

function summary(findings) {
  return findings.map(({ file, pointer, kind, severity, detail }) => ({ file, pointer, kind, severity, detail }));
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
    kind: 'enum-introduced',
    change: (t) => { t['core/explicit-open.json'].properties.name.enum = ['x', 'y']; },
    expected: { file: 'core/explicit-open.json', pointer: '/properties/name', detail: 'enum of 2 added' },
  },
  {
    kind: 'bound-tightened',
    change: (t) => { t['core/closed.json'].properties.count.minimum = 1; },
    expected: { file: 'core/closed.json', pointer: '/properties/count', detail: 'minimum 0 → 1' },
  },
  {
    kind: 'pattern-added',
    change: (t) => { t['core/explicit-open.json'].properties.name.pattern = '^[A-Z]'; },
    expected: { file: 'core/explicit-open.json', pointer: '/properties/name', detail: 'pattern "^[A-Z]" added' },
  },
  {
    kind: 'format-added',
    change: (t) => { t['core/explicit-open.json'].properties.name.format = 'email'; },
    expected: { file: 'core/explicit-open.json', pointer: '/properties/name', detail: 'format "email" added' },
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
    assert.deepEqual(summary(findingsAfter(change)), [{ ...expected, kind, severity: 'violation' }]);
  });
}

test('bound-tightened covers lowered maxima and newly added bounds', () => {
  assert.deepEqual(
    summary(findingsAfter((t) => { t['core/closed.json'].properties.label.maxLength = 40; })).map((f) => f.detail),
    ['maxLength 50 → 40'],
  );
  assert.deepEqual(
    summary(findingsAfter((t) => { t['core/open.json'].properties.tags.maxItems = 5; })).map((f) => f.detail),
    ['maxItems 5 added'],
  );
});

test('counts a property added to a closed object at that object’s pointer', () => {
  const findings = findingsAfter((t) => {
    t['core/union.json'].oneOf[1].properties.extra = { type: 'string' };
  });
  assert.deepEqual(summary(findings), [{
    file: 'core/union.json',
    pointer: '/oneOf/1',
    kind: 'property-added-to-closed',
    severity: 'violation',
    detail: 'property extra added',
  }]);
});

test('flags additionalProperties changed from true to false', () => {
  const findings = findingsAfter((t) => { t['core/explicit-open.json'].additionalProperties = false; });
  assert.deepEqual(findings.map((f) => [f.kind, f.detail]), [['additional-properties-closed', 'additionalProperties true → false']]);
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
// Additive changes pass
// ---------------------------------------------------------------------------

test('passes a property added to an object with no additionalProperties keyword', () => {
  assert.deepEqual(findingsAfter((t) => { t['core/open.json'].properties.extra = { type: 'string' }; }), []);
});

test('passes a new optional property on an object with additionalProperties: true', () => {
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

test('passes a new discriminated oneOf branch', () => {
  assert.deepEqual(findingsAfter((t) => {
    t['core/union.json'].oneOf.push({
      type: 'object',
      properties: { kind: { const: 'c' } },
      required: ['kind'],
      additionalProperties: false,
    });
  }), []);
});

// ---------------------------------------------------------------------------
// Undecidable changes are review, never violations
// ---------------------------------------------------------------------------

test('reports a changed pattern for review', () => {
  const findings = findingsAfter((t) => { t['core/closed.json'].properties.id.pattern = '^[a-z0-9]+$'; });
  assert.deepEqual(findings.map((f) => [f.kind, f.severity]), [['pattern-changed', 'review']]);
});

test('reports an undiscriminated oneOf branch for review', () => {
  const findings = findingsAfter((t) => { t['core/union.json'].oneOf.push({ type: 'string' }); });
  assert.deepEqual(findings.map((f) => [f.kind, f.severity]), [['oneof-branch-added', 'review']]);
});

test('reports an added allOf entry for review', () => {
  const findings = findingsAfter((t) => { t['core/open.json'].allOf = [{ required: ['version'] }]; });
  assert.deepEqual(findings.map((f) => [f.kind, f.severity]), [['composition-added', 'review']]);
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
  assert.deepEqual(summary(findings), [{
    file: 'core/closed.json',
    pointer: '/properties/status',
    kind: 'enum-value-removed',
    severity: 'violation',
    detail: 'value "paused" removed',
  }]);
});

test('matches oneOf branches by discriminator, not position', () => {
  const findings = findingsAfter((t) => { t['core/union.json'].oneOf.reverse(); });
  assert.deepEqual(findings, []);
});

test('a removed branch with no key is reported for review, not paired with another branch', () => {
  const findings = findingsAfter((t) => { t['core/scalar.json'].anyOf.shift(); });
  assert.deepEqual(summary(findings), [{
    file: 'core/scalar.json',
    pointer: '/anyOf/0',
    kind: 'branch-removed',
    severity: 'review',
    detail: 'anyOf branch #0 removed',
  }]);
});

test('a variant list moved into a shared union file still matches', () => {
  const candidate = fixture();
  candidate['core/variants.json'] = { $id: '/schemas/core/variants.json', oneOf: candidate['core/union.json'].oneOf };
  candidate['core/union.json'].oneOf = [{ $ref: '/schemas/core/variants.json' }];
  const { findings } = compareTrees(tree('base', fixture()), tree('candidate', candidate));
  assert.deepEqual(findings, []);
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

const VIOLATION_A = {
  file: 'core/a.json', pointer: '', kind: 'property-added-to-closed', severity: 'violation', detail: 'property x added',
};
const VIOLATION_B = {
  file: 'core/b.json', pointer: '', kind: 'required-added', severity: 'violation', detail: 'property y newly required',
};
const REVIEW = {
  file: 'core/c.json', pointer: '', kind: 'pattern-changed', severity: 'review', detail: 'pattern "a" → "b"',
};

function entry(finding, reason = PENDING_REASON) {
  const { file, pointer, kind, detail } = finding;
  return { file, pointer, kind, detail, reason };
}

test('recorded violations pass and review findings never fail', () => {
  const result = checkAgainstBaseline({
    base: '3.2.7',
    findings: [VIOLATION_A, REVIEW],
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

test('every baseline entry needs a reason and a violation kind', () => {
  const result = checkAgainstBaseline({
    base: '3.2.7',
    findings: [VIOLATION_A],
    baselineValue: { base: '3.2.7', entries: [{ ...entry(VIOLATION_A), reason: '' }, entry(REVIEW)] },
  });
  assert.deepEqual(result.errors, [
    'baseline entries[0].reason must not be empty',
    'baseline entries[1].kind pattern-changed is not a violation kind',
    `stale baseline entry: ${findingKey(REVIEW)} no longer occurs; remove it from the baseline`,
  ]);
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
