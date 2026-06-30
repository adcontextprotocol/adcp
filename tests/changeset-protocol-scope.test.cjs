#!/usr/bin/env node

const assert = require('assert');
const {
  changesetProtocolBump,
  changesetTargetsProtocol,
  findChangesetProtocolScopeViolations,
  hasProtocolScopedChanges,
  isChangesetBumpDowngradeOrRemoval,
  isChangesetBumpEscalation,
  isChangesetClassificationMaintenance,
  isChangesetDeleteOnlyCleanup,
  isChangesetEditOnlyMaintenance,
  isChangesetStatusExemptMaintenance,
  isProtocolScopedPath,
  parseNameStatus,
} = require('../scripts/check-changeset-protocol-scope.cjs');

const protocolChangeset = `---
"adcontextprotocol": patch
---

Update the protocol.
`;

const minorProtocolChangeset = `---
"adcontextprotocol": minor
---

Update the protocol.
`;

const majorProtocolChangeset = `---
"adcontextprotocol": major
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

function readFilesStrict(files) {
  return filePath => {
    if (Object.prototype.hasOwnProperty.call(files, filePath)) {
      return files[filePath];
    }
    throw new Error(`unexpected read: ${filePath}`);
  };
}

assert.strictEqual(changesetProtocolBump(protocolChangeset), 'patch');
assert.strictEqual(changesetProtocolBump(emptyChangeset), null);
assert.strictEqual(changesetTargetsProtocol(protocolChangeset), true);
assert.strictEqual(changesetTargetsProtocol(emptyChangeset), false);
assert.strictEqual(isChangesetBumpEscalation(protocolChangeset, minorProtocolChangeset), true);
assert.strictEqual(isChangesetBumpEscalation(minorProtocolChangeset, protocolChangeset), false);
assert.strictEqual(isChangesetBumpDowngradeOrRemoval(minorProtocolChangeset, protocolChangeset), true);
assert.strictEqual(isChangesetBumpDowngradeOrRemoval(minorProtocolChangeset, emptyChangeset), true);

assert.strictEqual(isProtocolScopedPath('static/schemas/source/media-buy/create-media-buy-request.json'), true);
assert.strictEqual(isProtocolScopedPath('static/compliance/source/universal/security.yaml'), true);
assert.strictEqual(isProtocolScopedPath('static/registry/policies/brand-safety.json'), false);
assert.strictEqual(isProtocolScopedPath('static/openapi/registry.yaml'), false);
assert.strictEqual(isProtocolScopedPath('static/schemas/source/core/registry-feed-response.json'), true);
assert.strictEqual(isProtocolScopedPath('docs/reference/versioning.mdx'), true);
assert.strictEqual(isProtocolScopedPath('docs/registry/index.mdx'), false);
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
  [{ status: 'M', paths: ['.changeset/existing-protocol-fix.md'] }],
  readFiles({ '.changeset/existing-protocol-fix.md': protocolChangeset }),
  readFiles({ '.changeset/existing-protocol-fix.md': minorProtocolChangeset })
);
assert.deepStrictEqual(violations, [], 'Downgrading an existing changeset for release classification is allowed');

violations = findChangesetProtocolScopeViolations(
  [{ status: 'M', paths: ['.changeset/existing-registry-fix.md'] }],
  readFiles({ '.changeset/existing-registry-fix.md': emptyChangeset }),
  readFiles({ '.changeset/existing-registry-fix.md': minorProtocolChangeset })
);
assert.deepStrictEqual(violations, [], 'Removing an existing protocol bump for release classification is allowed');

violations = findChangesetProtocolScopeViolations(
  [
    { status: 'M', paths: ['.changeset/existing-registry-fix.md'] },
    { status: 'D', paths: ['.changeset/deleted-protocol-fix.md'] },
  ],
  readFilesStrict({ '.changeset/existing-registry-fix.md': emptyChangeset }),
  readFilesStrict({
    '.changeset/existing-registry-fix.md': minorProtocolChangeset,
    '.changeset/deleted-protocol-fix.md': minorProtocolChangeset,
  })
);
assert.deepStrictEqual(violations, [], 'Classification maintenance with deleted changesets does not read missing HEAD files');

violations = findChangesetProtocolScopeViolations(
  [{ status: 'R100', paths: ['.changeset/old-name.md', '.changeset/new-name.md'] }],
  readFilesStrict({
    '.changeset/new-name.md': protocolChangeset,
  }),
  readFilesStrict({})
);
assert.strictEqual(violations.length, 1, 'Renamed protocol changesets are still content-checked');

violations = findChangesetProtocolScopeViolations(
  [{ status: 'M', paths: ['.changeset/existing-protocol-fix.md'] }],
  readFiles({ '.changeset/existing-protocol-fix.md': majorProtocolChangeset }),
  readFiles({ '.changeset/existing-protocol-fix.md': protocolChangeset })
);
assert.strictEqual(violations.length, 1, 'Escalating an existing changeset without protocol source changes must fail');

violations = findChangesetProtocolScopeViolations(
  [{ status: 'M', paths: ['.changeset/existing-protocol-fix.md'] }],
  readFiles({ '.changeset/existing-protocol-fix.md': protocolChangeset }),
  readFiles({ '.changeset/existing-protocol-fix.md': protocolChangeset })
);
assert.strictEqual(violations.length, 1, 'Editing protocol changeset prose without a classification downgrade still fails');

assert.strictEqual(
  isChangesetClassificationMaintenance(
    [{ status: 'M', paths: ['.changeset/existing-protocol-fix.md'] }],
    readFiles({ '.changeset/existing-protocol-fix.md': protocolChangeset }),
    readFiles({ '.changeset/existing-protocol-fix.md': minorProtocolChangeset })
  ),
  true,
  'Classification maintenance recognizes protocol bump downgrades'
);

assert.strictEqual(
  isChangesetClassificationMaintenance(
    [{ status: 'M', paths: ['.changeset/existing-protocol-fix.md'] }],
    readFiles({ '.changeset/existing-protocol-fix.md': majorProtocolChangeset }),
    readFiles({ '.changeset/existing-protocol-fix.md': protocolChangeset })
  ),
  false,
  'Classification maintenance rejects protocol bump escalations'
);

assert.strictEqual(
  isChangesetEditOnlyMaintenance([
    { status: 'M', paths: ['.changeset/existing-protocol-fix.md'] },
    { status: 'M', paths: ['scripts/check-changeset-protocol-scope.cjs'] },
    { status: 'M', paths: ['tests/changeset-protocol-scope.test.cjs'] },
  ]),
  true,
  'Existing changeset edits plus policy test maintenance are changeset maintenance'
);

assert.strictEqual(
  isChangesetEditOnlyMaintenance([
    { status: 'M', paths: ['.changeset/existing-protocol-fix.md'] },
    { status: 'M', paths: ['server/src/billing/subscription-sync.ts'] },
  ]),
  false,
  'Existing changeset edits plus app changes are not changeset maintenance'
);

assert.strictEqual(
  isChangesetEditOnlyMaintenance([{ status: 'A', paths: ['.changeset/new-protocol-fix.md'] }]),
  false,
  'New changesets are not changeset edit maintenance'
);

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
