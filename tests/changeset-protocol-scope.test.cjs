#!/usr/bin/env node

const assert = require('assert');
const {
  changesetTargetsProtocol,
  findChangesetProtocolScopeViolations,
  hasProtocolScopedChanges,
  isChangesetDeleteOnlyCleanup,
  isChangesetStatusExemptMaintenance,
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
assert.strictEqual(
  hasProtocolScopedChanges([{ status: 'M', paths: ['server/src/billing/subscription-sync.ts'] }]),
  false,
  'App-only changes do not require changesets status'
);
assert.strictEqual(
  hasProtocolScopedChanges([{ status: 'M', paths: ['docs/reference/versioning.mdx'] }]),
  true,
  'Normative reference docs require changesets status'
);

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
assert.strictEqual(violations.length, 1, 'App-only changes with an empty changeset must fail');

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
  isChangesetStatusExemptMaintenance([
    { status: 'D', paths: ['.changeset/old-app-fix.md'] },
    { status: 'M', paths: ['.agents/playbook.md'] },
    { status: 'M', paths: ['.agents/routines/context-refresh-prompt.md'] },
    { status: 'M', paths: ['.agents/routines/triage-prompt.md'] },
    { status: 'M', paths: ['.agents/shortcuts/cut-beta.md'] },
    { status: 'M', paths: ['.agents/shortcuts/prep-for-pr.md'] },
    { status: 'M', paths: ['docs/reference/changelog.mdx'] },
    { status: 'M', paths: ['docs/spec-guidelines.md'] },
  ]),
  true,
  'Changeset policy/runbook maintenance can bypass changesets status without adding an empty changeset'
);

assert.strictEqual(
  isChangesetStatusExemptMaintenance([
    { status: 'M', paths: ['.agents/playbook.md'] },
    { status: 'M', paths: ['.agents/shortcuts/prep-empty.md'] },
  ]),
  true,
  'Policy-only maintenance can bypass changesets status even when no changeset file is touched'
);

assert.strictEqual(
  isChangesetStatusExemptMaintenance([
    { status: 'M', paths: ['.agents/playbook.md'] },
    { status: 'M', paths: ['server/src/billing/subscription-sync.ts'] },
  ]),
  false,
  'Policy docs plus app changes still need normal changesets status'
);

assert.strictEqual(
  isChangesetDeleteOnlyCleanup([
    { status: 'D', paths: ['.changeset/old-app-fix.md'] },
    { status: 'M', paths: ['server/src/billing/subscription-sync.ts'] },
  ]),
  false,
  'App changes plus a deleted changeset still need normal changesets status'
);

assert.strictEqual(
  isChangesetStatusExemptMaintenance([
    { status: 'A', paths: ['.changeset/new-empty.md'] },
    { status: 'M', paths: ['.agents/playbook.md'] },
  ]),
  false,
  'Adding a new changeset is not maintenance-exempt'
);

console.log('Changeset protocol scope tests passed.');
