#!/usr/bin/env node

const assert = require('assert');
const {
  findImmutableArtifactViolations,
  formatViolationMessage,
  parseImmutableArtifactPath,
  parseNameStatus,
} = require('../scripts/check-immutable-release-artifacts.cjs');

function hasBasePath(paths) {
  const basePaths = new Set(paths);
  return path => basePaths.has(path);
}

assert.deepStrictEqual(parseImmutableArtifactPath('dist/compliance/latest/index.json'), null);

assert.deepStrictEqual(
  parseImmutableArtifactPath('.\\dist\\schemas\\3.2.0-beta.11\\index.json'),
  {
    kind: 'schemas',
    version: '3.2.0-beta.11',
    releaseRoot: 'dist/schemas/3.2.0-beta.11',
    probePaths: ['dist/schemas/3.2.0-beta.11'],
  }
);

assert.deepStrictEqual(
  parseImmutableArtifactPath('dist/compliance/3.0.14/universal/idempotency.yaml'),
  {
    kind: 'compliance',
    version: '3.0.14',
    releaseRoot: 'dist/compliance/3.0.14',
    probePaths: ['dist/compliance/3.0.14'],
  }
);

assert.deepStrictEqual(
  parseNameStatus(
    'M\tdist/compliance/3.0.14/index.json\nD\tdist/schemas/3.0.14/index.json\nR100\tdist/docs/3.0.14/a.md\tdist/docs/3.0.14/b.md\nC100\tsource.tgz\tdist/protocol/3.0.14.tgz\n'
  ),
  [
    { status: 'M', paths: ['dist/compliance/3.0.14/index.json'] },
    { status: 'D', paths: ['dist/schemas/3.0.14/index.json'] },
    { status: 'R100', paths: ['dist/docs/3.0.14/a.md', 'dist/docs/3.0.14/b.md'] },
    { status: 'C100', paths: ['source.tgz', 'dist/protocol/3.0.14.tgz'] },
  ]
);

assert.deepStrictEqual(
  parseImmutableArtifactPath('dist/protocol/3.1.0-beta.0.tgz.sha256'),
  {
    kind: 'protocol',
    version: '3.1.0-beta.0',
    releaseRoot: 'dist/protocol/3.1.0-beta.0',
    probePaths: [
      'dist/protocol/3.1.0-beta.0.tgz',
      'dist/protocol/3.1.0-beta.0.tgz.sha256',
      'dist/protocol/3.1.0-beta.0.tgz.sig',
      'dist/protocol/3.1.0-beta.0.tgz.crt',
    ],
  }
);

let violations = findImmutableArtifactViolations(
  [
    { status: 'M', paths: ['dist/compliance/3.0.14/universal/idempotency.yaml'] },
    { status: 'A', paths: ['dist/compliance/3.0.15/index.json'] },
    { status: 'M', paths: ['dist/compliance/latest/index.json'] },
  ],
  hasBasePath(['dist/compliance/3.0.14'])
);
assert.deepStrictEqual(violations, [
  {
    status: 'M',
    path: 'dist/compliance/3.0.14/universal/idempotency.yaml',
    releaseRoot: 'dist/compliance/3.0.14',
  },
]);

violations = findImmutableArtifactViolations(
  [{ status: 'A', paths: ['dist/compliance/3.1.0-rc.15/index.json'] }],
  hasBasePath(['dist/compliance/3.1.0-rc.14'])
);
assert.deepStrictEqual(violations, []);

violations = findImmutableArtifactViolations(
  [{ status: 'A', paths: ['dist/schemas/3.0.14/new-schema.json'] }],
  hasBasePath(['dist/schemas/3.0.14'])
);
assert.strictEqual(violations.length, 1, 'Adding files to an existing schema release must fail');

violations = findImmutableArtifactViolations(
  [{ status: 'D', paths: ['dist/schemas/3.1.1/index.json'] }],
  hasBasePath(['dist/schemas/3.1.1']),
  version => version !== '3.1.1'
);
assert.deepStrictEqual(violations, [], 'Deleting artifacts for an untagged aborted release is allowed');

violations = findImmutableArtifactViolations(
  [{ status: 'D', paths: ['dist/schemas/3.1.1/index.json'] }],
  hasBasePath(['dist/schemas/3.1.1'])
);
assert.strictEqual(violations.length, 1, 'Deleting a tagged stable artifact must fail');

violations = findImmutableArtifactViolations(
  [{ status: 'D', paths: ['dist/schemas/3.2.0-beta.11/index.json'] }],
  hasBasePath(['dist/schemas/3.2.0-beta.11'])
);
assert.strictEqual(violations.length, 1, 'Deleting one file from a tagged beta schema must fail');

violations = findImmutableArtifactViolations(
  [{ status: 'D', paths: ['dist/compliance/3.2.0-beta.11/index.json'] }],
  hasBasePath(['dist/compliance/3.2.0-beta.11'])
);
assert.strictEqual(violations.length, 1, 'Deleting one file from tagged beta compliance must fail');

violations = findImmutableArtifactViolations(
  [{ status: 'D', paths: ['dist/protocol/3.2.0-beta.11.tgz'] }],
  hasBasePath(['dist/protocol/3.2.0-beta.11.tgz'])
);
assert.strictEqual(violations.length, 1, 'Deleting a tagged beta protocol tarball must fail');

violations = findImmutableArtifactViolations(
  [{ status: 'D', paths: ['dist/protocol/3.2.0-beta.11.tgz.sig'] }],
  hasBasePath(['dist/protocol/3.2.0-beta.11.tgz'])
);
assert.strictEqual(violations.length, 1, 'Deleting a tagged beta protocol sidecar must fail');

violations = findImmutableArtifactViolations(
  [{ status: 'D', paths: ['dist/schemas/3.2.0-rc.1/index.json'] }],
  hasBasePath(['dist/schemas/3.2.0-rc.1'])
);
assert.strictEqual(violations.length, 1, 'Deleting a tagged release-candidate artifact must still fail');

violations = findImmutableArtifactViolations(
  [{ status: 'M', paths: ['dist/protocol/3.0.14.tgz.sha256'] }],
  hasBasePath(['dist/protocol/3.0.14.tgz'])
);
assert.strictEqual(violations.length, 1, 'Changing sidecars for an existing protocol tarball must fail');

violations = findImmutableArtifactViolations(
  [{ status: 'M', paths: ['dist/protocol/3.1.0-beta.0.tgz.sig'] }],
  hasBasePath(['dist/protocol/3.1.0-beta.0.tgz'])
);
assert.deepStrictEqual(violations, [
  {
    status: 'M',
    path: 'dist/protocol/3.1.0-beta.0.tgz.sig',
    releaseRoot: 'dist/protocol/3.1.0-beta.0',
  },
]);

const message = formatViolationMessage(violations);
assert(message.includes('Do not patch existing versioned dist artifacts in-place.'));
assert(message.includes('ship a new versioned artifact'));

console.log('Immutable release artifact tests passed.');
