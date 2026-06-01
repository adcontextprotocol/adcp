const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { assertCompliancePackagedRefs, lint } = require('../scripts/lint-compliance-packaged-refs.cjs');

const ROOT = path.join(__dirname, '..');
const COMPLIANCE_SOURCE = path.join(ROOT, 'static', 'compliance', 'source');

function withTempComplianceTree(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-packaged-refs-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

test('source compliance tree has only packaged-resolvable vector and test-kit refs', () => {
  const violations = lint(COMPLIANCE_SOURCE);
  assert.deepEqual(
    violations,
    [],
    'real compliance YAML has references that would not ship:\n' +
      violations.map((v) => `  ${v.file} ${v.path}: ${v.reason}`).join('\n'),
  );
});

test('accepts versioned test-vector refs with group/id fragments', () => {
  withTempComplianceTree((dir) => {
    write(
      path.join(dir, 'test-vectors', 'webhook-receiver-envelope.json'),
      JSON.stringify({
        positive: [{ id: 'ok' }],
        negative: [{ id: 'bad' }],
      }),
    );
    write(
      path.join(dir, 'universal', 'receiver.yaml'),
      `
id: receiver
prerequisites:
  vectors: "test-vectors/webhook-receiver-envelope.json"
phases:
  - id: p
    steps:
      - id: s
        vector_ref: "test-vectors/webhook-receiver-envelope.json#positive/ok"
`,
    );

    assert.deepEqual(lint(dir), []);
  });
});

test('accepts compliance-version refs and runner fixture keys', () => {
  withTempComplianceTree((dir) => {
    write(path.join(dir, 'test-vectors', 'request-signing', 'keys.json'), '{}');
    write(
      path.join(dir, 'test-vectors', 'catalog-macro-substitution.json'),
      JSON.stringify({ vectors: [{ name: 'reserved-character-breakout' }] }),
    );
    write(
      path.join(dir, 'test-kits', 'runner.yaml'),
      `
id: runner
applies_to:
  universal_storyboard: signed-requests
auth:
  request_signing:
    jwks_source: /compliance/{version}/test-vectors/request-signing/keys.json
references:
  source_fixture: test-vectors/catalog-macro-substitution.json
  unit_test_fixture: test-vectors/catalog-macro-substitution.json
  test_vectors: /compliance/{version}/test-vectors/request-signing/
`,
    );

    assert.deepEqual(lint(dir), []);
  });
});

test('rejects source-tree-only static/test-vectors refs', () => {
  withTempComplianceTree((dir) => {
    write(
      path.join(dir, 'universal', 'receiver.yaml'),
      `
id: receiver
phases:
  - id: p
    steps:
      - id: s
        vector_ref: "static/test-vectors/webhook-receiver-envelope.json#positive/ok"
`,
    );

    const violations = lint(dir);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].key, 'vector_ref');
    assert.match(violations[0].reason, /referenced packaged file is missing/);
  });
});

test('rejects source-tree-only source_fixture refs', () => {
  withTempComplianceTree((dir) => {
    write(
      path.join(dir, 'test-kits', 'runner.yaml'),
      `
id: runner
applies_to:
  specialism: sales-catalog-driven
source_fixture: static/test-vectors/catalog-macro-substitution.json
`,
    );

    const violations = lint(dir);
    assert.equal(violations.length, 1);
    assert.equal(violations[0].key, 'source_fixture');
    assert.match(violations[0].reason, /referenced packaged file is missing/);
  });
});

test('rejects missing vector fragments', () => {
  withTempComplianceTree((dir) => {
    write(
      path.join(dir, 'test-vectors', 'vectors.json'),
      JSON.stringify({ positive: [{ id: 'exists' }] }),
    );
    write(
      path.join(dir, 'universal', 'receiver.yaml'),
      `
id: receiver
phases:
  - id: p
    steps:
      - id: s
        vector_ref: "test-vectors/vectors.json#positive/missing"
`,
    );

    const violations = lint(dir);
    assert.equal(violations.length, 1);
    assert.match(violations[0].reason, /fragment "#positive\/missing" was not found/);
  });
});

test('assertCompliancePackagedRefs throws build-friendly errors', () => {
  withTempComplianceTree((dir) => {
    write(
      path.join(dir, 'universal', 'receiver.yaml'),
      `
id: receiver
prerequisites:
  vectors: "test-vectors/missing.json"
`,
    );

    assert.throws(
      () => assertCompliancePackagedRefs(dir, 'staged bundle refs'),
      /staged bundle refs: 1 unresolved reference/,
    );
  });
});
