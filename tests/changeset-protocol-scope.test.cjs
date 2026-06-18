#!/usr/bin/env node

const assert = require('assert');
const {
  changesetTargetsProtocol,
  findChangesetProtocolScopeViolations,
  isChangesetDeleteOnlyCleanup,
  isProtocolScopedPath,
  parseNameStatus,
} = require('../scripts/check-changeset-protocol-scope.cjs');

const protocolChangeset = `---
"adcontextprotocol": patch
---

Update the protocol.
`;

const emptyChangeset = `---
---

No package release.
`;

function readFiles(files) {
  return filePath => files[filePath] || '';
}

assert.strictEqual(changesetTargetsProtocol(protocolChangeset), true);
assert.strictEqual(changesetTargetsProtocol(emptyChangeset), false);

assert.strictEqual(isProtocolScopedPath('static/schemas/source/media-buy/create-media-buy-request.json'), true);
assert.strictEqual(isProtocolScopedPath('static/compliance/source/universal/security.yaml'), true);
assert.strictEqual(isProtocolScopedPath('docs/reference/versioning.mdx'), true);
assert.strictEqual(isProtocolScopedPath('server/src/billing/subscription-sync.ts'), false);
assert.strictEqual(isProtocolScopedPath('.changeset/billing-fix.md'), false);

assert.deepStrictEqual(
  parseNameStatus('M\tserver/src/billing/subscription-sync.ts\nA\t.changeset/billing-fix.md\n'),
  [
    { status: 'M', paths: ['server/src/billing/subscription-sync.ts'] },
    { status: 'A', paths: ['.changeset/billing-fix.md'] },
  ]
);

let violations = findChangesetProtocolScopeViolations(
  [
    { status: 'M', paths: ['server/src/billing/subscription-sync.ts'] },
    { status: 'A', paths: ['.changeset/billing-fix.md'] },
  ],
  readFiles({ '.changeset/billing-fix.md': protocolChangeset })
);
assert.strictEqual(violations.length, 1, 'App-only changes with a protocol changeset must fail');

violations = findChangesetProtocolScopeViolations(
  [
    { status: 'M', paths: ['static/schemas/source/media-buy/create-media-buy-request.json'] },
    { status: 'A', paths: ['.changeset/schema-fix.md'] },
  ],
  readFiles({ '.changeset/schema-fix.md': protocolChangeset })
);
assert.deepStrictEqual(violations, [], 'Schema changes with a protocol changeset are allowed');

violations = findChangesetProtocolScopeViolations(
  [
    { status: 'M', paths: ['server/src/billing/subscription-sync.ts'] },
    { status: 'A', paths: ['.changeset/empty.md'] },
  ],
  readFiles({ '.changeset/empty.md': emptyChangeset })
);
assert.deepStrictEqual(violations, [], 'Empty/non-package changesets are not treated as protocol releases');

violations = findChangesetProtocolScopeViolations(
  [{ status: 'D', paths: ['.changeset/old-app-fix.md'] }],
  readFiles({ '.changeset/old-app-fix.md': protocolChangeset })
);
assert.deepStrictEqual(violations, [], 'Deleting a bad changeset is allowed');

assert.strictEqual(
  isChangesetDeleteOnlyCleanup([
    { status: 'D', paths: ['.changeset/old-app-fix.md'] },
    { status: 'M', paths: ['.github/workflows/changeset-check.yml'] },
    { status: 'A', paths: ['scripts/check-changeset-protocol-scope.cjs'] },
    { status: 'A', paths: ['tests/changeset-protocol-scope.test.cjs'] },
  ]),
  true,
  'Deleting a changeset while maintaining the policy check can bypass changesets status'
);

assert.strictEqual(
  isChangesetDeleteOnlyCleanup([
    { status: 'D', paths: ['.changeset/old-app-fix.md'] },
    { status: 'M', paths: ['server/src/billing/subscription-sync.ts'] },
  ]),
  false,
  'App changes plus a deleted changeset still need normal changesets status'
);

console.log('Changeset protocol scope tests passed.');
