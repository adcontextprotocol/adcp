#!/usr/bin/env node

const assert = require('assert');
const {
  changesetProtocolBump,
  changesetTargetsProtocol,
  findArchivedChangesetViolations,
  findChangesetProtocolScopeViolations,
  formatViolationMessage,
  hasProtocolScopedChanges,
  isChangesetArchivePath,
  isChangesetBumpDowngradeOrRemoval,
  isChangesetBumpEscalation,
  isChangesetClassificationMaintenance,
  isChangesetDeleteOnlyCleanup,
  isChangesetEditOnlyMaintenance,
  isChangesetStatusExemptMaintenance,
  isProtocolScopedPath,
  isReleaseAuditChangesetMaintenance,
  isStoryboardBranchRegistrationOnly,
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

const rewordedProtocolChangeset = protocolChangeset.replace('Update the protocol.', 'Clarify the protocol.');
const releaseAudit = { headRef: 'release-audit/3.3.0-beta.1' };

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
assert.strictEqual(isProtocolScopedPath('docs/trusted-match/specification.mdx'), true);
assert.strictEqual(isProtocolScopedPath('docs/trusted-match/router-architecture.mdx'), true);
assert.strictEqual(isProtocolScopedPath('docs/trusted-match/data-protection-roles.mdx'), false);
assert.strictEqual(isProtocolScopedPath('docs/trusted-match/surfaces/web.mdx'), false);
assert.strictEqual(isProtocolScopedPath('docs/registry/index.mdx'), false);
assert.strictEqual(isProtocolScopedPath('scripts/run-storyboards-isolated.mjs'), true);
assert.strictEqual(isProtocolScopedPath('server/src/billing/subscription-sync.ts'), false);
assert.strictEqual(isProtocolScopedPath('.changeset/billing-fix.md'), false);
assert.strictEqual(isProtocolScopedPath('.github/workflows/release.yml'), false);
assert.strictEqual(isProtocolScopedPath('.github/workflows/training-agent-storyboards.yml'), true);
assert.strictEqual(isProtocolScopedPath('scripts/build-protocol-tarball.cjs'), true);
const storyboardWorkflowPath = '.github/workflows/training-agent-storyboards.yml';
const storyboardWorkflowBase = `pull_request:\n  branches: [main, '3.1.x', '3.0.x']\npush:\n  branches: [main, '3.1.x', '3.0.x']\njob: run\n`;
const storyboardWorkflowRegistered = storyboardWorkflowBase.replaceAll(
  "branches: [main, '3.1.x', '3.0.x']",
  "branches: [main, '3.2.x', '3.1.x', '3.0.x']"
);
const storyboardChange = [{ status: 'M', paths: [storyboardWorkflowPath] }];
assert.strictEqual(
  isStoryboardBranchRegistrationOnly(storyboardWorkflowRegistered, storyboardWorkflowBase),
  true
);
assert.strictEqual(
  hasProtocolScopedChanges(
    storyboardChange,
    readFiles({ [storyboardWorkflowPath]: storyboardWorkflowRegistered }),
    readFiles({ [storyboardWorkflowPath]: storyboardWorkflowBase })
  ),
  false,
  'Registering the exact two 3.2.x CI triggers does not release the protocol'
);
assert.strictEqual(
  hasProtocolScopedChanges(
    storyboardChange,
    readFiles({ [storyboardWorkflowPath]: `${storyboardWorkflowRegistered}another job\n` }),
    readFiles({ [storyboardWorkflowPath]: storyboardWorkflowBase })
  ),
  true,
  'Changes to storyboard jobs remain protocol scoped'
);
assert.strictEqual(
  hasProtocolScopedChanges(
    storyboardChange,
    readFiles({ [storyboardWorkflowPath]: storyboardWorkflowRegistered.replace('push:\n  branches: [main, \'3.2.x\',', 'push:\n  branches: [main,') }),
    readFiles({ [storyboardWorkflowPath]: storyboardWorkflowBase })
  ),
  true,
  'Both pull request and push trigger lists must be registered together'
);
assert.strictEqual(
  findChangesetProtocolScopeViolations(
    [...storyboardChange, { status: 'A', paths: ['.changeset/empty-workflow.md'] }],
    readFiles({
      [storyboardWorkflowPath]: storyboardWorkflowRegistered,
      '.changeset/empty-workflow.md': emptyChangeset,
    }),
    readFiles({ [storyboardWorkflowPath]: storyboardWorkflowBase })
  ).length,
  1,
  'Branch registration cannot justify an artificial protocol changeset'
);
assert.strictEqual(
  hasProtocolScopedChanges([
    { status: 'M', paths: ['.github/workflows/release.yml'] },
    { status: 'M', paths: ['scripts/backfill-cdn-artifacts.sh'] },
    { status: 'A', paths: ['scripts/check-release-state.cjs'] },
  ]),
  false,
  'Release publication controls do not schedule a protocol release'
);
assert.strictEqual(
  hasProtocolScopedChanges([
    { status: 'M', paths: ['.github/workflows/release.yml'] },
    { status: 'M', paths: ['static/schemas/source/core/product.json'] },
  ]),
  true,
  'A publication workflow change must not exempt accompanying protocol content'
);

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

const storyboardWorkflow = '.github/workflows/training-agent-storyboards.yml';
const installOnlyChange = { status: 'M', paths: [storyboardWorkflow] };
const beforeInstall = 'jobs:\n  check:\n    steps:\n      - name: Install\n        run: npm ci\n      - name: Install again\n        run: npm ci\n';
const afterInstall = beforeInstall.replaceAll('run: npm ci', 'run: node .github/scripts/npm-ci.mjs');
const readBeforeInstall = readFilesStrict({ [storyboardWorkflow]: beforeInstall });
const readAfterInstall = readFilesStrict({ [storyboardWorkflow]: afterInstall });
assert.strictEqual(isProtocolScopedPath(storyboardWorkflow), true, 'Keep default storyboard protocol classification');
assert.strictEqual(hasProtocolScopedChanges([installOnlyChange], readAfterInstall, readBeforeInstall), false,
  'Exact install-only substitution does not change the protocol surface');
assert.strictEqual(hasProtocolScopedChanges([installOnlyChange]), true, 'Missing readers fail closed');
assert.strictEqual(hasProtocolScopedChanges([installOnlyChange], readAfterInstall, readFilesStrict({})), true,
  'Unreadable base fails closed');
assert.strictEqual(hasProtocolScopedChanges([installOnlyChange], readFilesStrict({}), readBeforeInstall), true,
  'Unreadable head fails closed');
for (const head of [
  beforeInstall,
  afterInstall + '    if: false\n',
  afterInstall.replace('check:', 'changed:'),
  afterInstall.replaceAll('npm-ci.mjs', 'npm-ci.mjs --ignore-scripts'),
  afterInstall.replaceAll('npm-ci.mjs', 'npm-ci.mjs; true'),
  afterInstall.replaceAll('npm-ci.mjs', 'other.mjs'),
]) {
  assert.strictEqual(hasProtocolScopedChanges([installOnlyChange], readFiles({ [storyboardWorkflow]: head }), readBeforeInstall), true,
    'Any other workflow delta retains protocol classification');
}
// The branch-registration guard stays in force alongside the install exemption.
assert.strictEqual(hasProtocolScopedChanges(storyboardChange,
  readFiles({ [storyboardWorkflowPath]: storyboardWorkflowRegistered + '        run: node .github/scripts/npm-ci.mjs\n' }),
  readFiles({ [storyboardWorkflowPath]: storyboardWorkflowBase })), true,
  'Branch registration plus install substitution in one edit is not exempt');
for (const status of ['A', 'D', 'T', 'R100', 'C100']) {
  assert.strictEqual(hasProtocolScopedChanges([{ status, paths: [storyboardWorkflow] }], readAfterInstall, readBeforeInstall), true,
    `${status} is not an install-only modification`);
}
assert.strictEqual(hasProtocolScopedChanges([
  { status: 'R100', paths: [storyboardWorkflow, '.github/workflows/renamed.yml'] },
], readAfterInstall, readBeforeInstall), true, 'Workflow rename remains protocol-scoped');
assert.strictEqual(hasProtocolScopedChanges([
  { status: 'M', paths: ['.github/workflows/release.yml'] },
], () => afterInstall, () => beforeInstall), false, 'Release workflow remains operational, never classified by the install exemption');
assert.strictEqual(hasProtocolScopedChanges([
  { status: 'M', paths: ['.github/workflows/release.yml'] },
  installOnlyChange,
  { status: 'M', paths: ['static/schemas/source/core/example.json'] },
], readAfterInstall, readBeforeInstall), true, 'Release plus install-only work cannot hide protocol content');
for (const filePath of ['static/schemas/source/core/example.json', 'docs/reference/versioning.mdx', 'scripts/run-storyboards-isolated.mjs']) {
  assert.strictEqual(hasProtocolScopedChanges([installOnlyChange, { status: 'M', paths: [filePath] }], readAfterInstall, readBeforeInstall), true,
    'Mixed protocol changes still require changesets status');
}
for (const content of [protocolChangeset, emptyChangeset]) {
  assert.strictEqual(findChangesetProtocolScopeViolations([
    installOnlyChange, { status: 'A', paths: ['.changeset/ci-only.md'] },
  ], readFilesStrict({ [storyboardWorkflow]: afterInstall, '.changeset/ci-only.md': content }), readBeforeInstall).length, 1,
  'Install-only CI changes reject both protocol and empty changesets');
}
assert.deepStrictEqual(findChangesetProtocolScopeViolations([installOnlyChange], readAfterInstall, readBeforeInstall), [],
  'Install-only CI work passes scope without a changeset');

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
    { status: 'M', paths: ['docs/trusted-match/specification.mdx'] },
    { status: 'A', paths: ['.changeset/tmp-cache-fix.md'] },
  ],
  readFiles({ '.changeset/tmp-cache-fix.md': protocolChangeset })
);
assert.deepStrictEqual(violations, [], 'Authoritative TMP docs with a protocol changeset are allowed');

violations = findChangesetProtocolScopeViolations(
  [
    { status: 'M', paths: ['docs/trusted-match/surfaces/web.mdx'] },
    { status: 'A', paths: ['.changeset/tmp-prose.md'] },
  ],
  readFiles({ '.changeset/tmp-prose.md': protocolChangeset })
);
assert.strictEqual(
  violations.length,
  1,
  'Unrelated Trusted Match prose with a protocol changeset must fail'
);

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

violations = findChangesetProtocolScopeViolations(
  [{ status: 'M', paths: ['.changeset/existing-protocol-fix.md'] }],
  readFiles({ '.changeset/existing-protocol-fix.md': rewordedProtocolChangeset }),
  readFiles({ '.changeset/existing-protocol-fix.md': protocolChangeset }),
  releaseAudit
);
assert.deepStrictEqual(violations, [], 'Release-audit branches can edit protocol changeset text');

violations = findChangesetProtocolScopeViolations(
  [
    { status: 'M', paths: ['.changeset/existing-protocol-fix.md'] },
    { status: 'D', paths: ['.changeset/old-app-fix.md'] },
  ],
  readFiles({ '.changeset/existing-protocol-fix.md': majorProtocolChangeset }),
  readFiles({ '.changeset/existing-protocol-fix.md': protocolChangeset }),
  releaseAudit
);
assert.deepStrictEqual(violations, [], 'Release-audit branches can escalate a misclassified changeset bump');

violations = findChangesetProtocolScopeViolations(
  [{ status: 'M', paths: ['.changeset/existing-protocol-fix.md'] }],
  readFiles({ '.changeset/existing-protocol-fix.md': majorProtocolChangeset }),
  readFiles({ '.changeset/existing-protocol-fix.md': protocolChangeset }),
  { headRef: 'fix/release-audit/escalate' }
);
assert.strictEqual(violations.length, 1, 'Only the release-audit/ head-branch prefix relaxes changeset edits');

violations = findChangesetProtocolScopeViolations(
  [
    { status: 'M', paths: ['.changeset/existing-protocol-fix.md'] },
    { status: 'M', paths: ['server/src/billing/subscription-sync.ts'] },
  ],
  readFiles({ '.changeset/existing-protocol-fix.md': majorProtocolChangeset }),
  readFiles({ '.changeset/existing-protocol-fix.md': protocolChangeset }),
  releaseAudit
);
assert.strictEqual(violations.length, 1, 'Release-audit branches that touch non-changeset files are checked normally');

violations = findChangesetProtocolScopeViolations(
  [{ status: 'A', paths: ['.changeset/new-protocol-fix.md'] }],
  readFiles({ '.changeset/new-protocol-fix.md': protocolChangeset }),
  readFiles({}),
  releaseAudit
);
assert.strictEqual(violations.length, 1, 'Release-audit branches cannot add new protocol changesets');

assert.strictEqual(
  isReleaseAuditChangesetMaintenance(
    [{ status: 'M', paths: ['.changeset/existing-protocol-fix.md'] }],
    'main'
  ),
  false,
  'Changeset edits from other branches are not release-audit maintenance'
);

assert.strictEqual(
  isReleaseAuditChangesetMaintenance(
    [{ status: 'R090', paths: ['.changeset/old-name.md', '.changeset/new-name.md'] }],
    releaseAudit.headRef
  ),
  false,
  'Release-audit maintenance does not cover renamed changesets'
);

assert.strictEqual(
  isReleaseAuditChangesetMaintenance([], releaseAudit.headRef),
  false,
  'An empty diff is not release-audit maintenance'
);

// Archived prerelease changesets (.changeset/pre/*.md)
const archivedPath = '.changeset/pre/x.md';
const protocolSourcePath = 'static/schemas/source/core/product.json';
const noFiles = readFiles({});
const archivedHead = readFiles({ [archivedPath]: rewordedProtocolChangeset });
const archivedBase = readFiles({ [archivedPath]: protocolChangeset });
const ordinaryBranches = [{ headRef: 'fix/some-change' }, {}];
const archivedOnly = violations => violations.length === 1 && violations[0].kind === 'archived';

for (const opts of ordinaryBranches) {
  const label = `ordinary branch ${JSON.stringify(opts)}`;

  violations = findChangesetProtocolScopeViolations(
    [{ status: 'M', paths: [archivedPath] }], archivedHead, archivedBase, opts
  );
  assert.ok(archivedOnly(violations), `${label}: editing an archived changeset yields one archived violation`);

  violations = findChangesetProtocolScopeViolations([{ status: 'D', paths: [archivedPath] }], noFiles, archivedBase, opts);
  assert.ok(archivedOnly(violations), `${label}: deleting an archived changeset fails`);

  violations = findChangesetProtocolScopeViolations([{ status: 'A', paths: [archivedPath] }], archivedHead, noFiles, opts);
  assert.ok(archivedOnly(violations), `${label}: adding an archived changeset fails`);

  violations = findChangesetProtocolScopeViolations(
    [{ status: 'R100', paths: ['.changeset/x.md', archivedPath] }], archivedHead, archivedBase, opts
  );
  assert.ok(archivedOnly(violations), `${label}: renaming a changeset into the archive fails`);

  violations = findChangesetProtocolScopeViolations(
    [{ status: 'R050', paths: [archivedPath, '.changeset/x.md'] }], archivedHead, archivedBase, opts
  );
  assert.ok(archivedOnly(violations), `${label}: renaming a changeset out of the archive fails`);
}

violations = findChangesetProtocolScopeViolations(
  [
    { status: 'M', paths: [protocolSourcePath] },
    { status: 'A', paths: ['.changeset/new-protocol-fix.md'] },
    { status: 'M', paths: [archivedPath] },
  ],
  readFiles({ '.changeset/new-protocol-fix.md': protocolChangeset, [archivedPath]: rewordedProtocolChangeset }),
  archivedBase,
  { headRef: 'fix/some-change' }
);
assert.ok(archivedOnly(violations), 'Protocol files do not excuse archive edits: exactly one archived violation');

violations = findChangesetProtocolScopeViolations(
  [
    { status: 'M', paths: ['.changeset/existing-protocol-fix.md'] },
    { status: 'M', paths: [archivedPath] },
  ],
  readFiles({ '.changeset/existing-protocol-fix.md': protocolChangeset, [archivedPath]: rewordedProtocolChangeset }),
  readFiles({ '.changeset/existing-protocol-fix.md': minorProtocolChangeset, [archivedPath]: protocolChangeset }),
  { headRef: 'fix/some-change' }
);
assert.ok(archivedOnly(violations), 'A root downgrade stays valid; the pending verdict ignores archived paths');

assert.strictEqual(isChangesetArchivePath('.changeset/pre/x.md'), true, 'pre/*.md is in the archive');
assert.strictEqual(isChangesetArchivePath('.changeset/pre/x.json'), true, 'The whole pre/ subtree is guarded, not only .md files');
assert.strictEqual(isChangesetArchivePath('.changeset/pre/sub/x.md'), true, 'Nested pre/ paths are guarded');
assert.strictEqual(isChangesetArchivePath('.changeset/pre.json'), false, 'pre.json is not in the archive');
assert.strictEqual(isChangesetArchivePath('.changeset/prefix.md'), false, 'A root changeset whose name starts with "pre" is not in the archive');

// release-audit/ branches
violations = findChangesetProtocolScopeViolations(
  [{ status: 'M', paths: [archivedPath] }], archivedHead, archivedBase, releaseAudit
);
assert.deepStrictEqual(violations, [], 'Release-audit branches can edit archived changeset text');

violations = findChangesetProtocolScopeViolations([{ status: 'D', paths: [archivedPath] }], noFiles, archivedBase, releaseAudit);
assert.deepStrictEqual(violations, [], 'Release-audit branches can delete archived changesets');

violations = findChangesetProtocolScopeViolations(
  [
    { status: 'M', paths: ['.changeset/a.md'] },
    { status: 'M', paths: ['.changeset/pre/b.md'] },
  ],
  readFiles({ '.changeset/a.md': majorProtocolChangeset, '.changeset/pre/b.md': protocolChangeset }),
  readFiles({ '.changeset/a.md': protocolChangeset, '.changeset/pre/b.md': minorProtocolChangeset }),
  releaseAudit
);
assert.deepStrictEqual(violations, [], 'Release-audit branches can escalate and downgrade archived bumps, like root changesets');

violations = findChangesetProtocolScopeViolations(
  [
    { status: 'M', paths: ['.changeset/a.md'] },
    { status: 'M', paths: ['.changeset/pre/b.md'] },
    { status: 'D', paths: ['.changeset/pre/c.md'] },
  ],
  readFiles({ '.changeset/a.md': rewordedProtocolChangeset, '.changeset/pre/b.md': rewordedProtocolChangeset }),
  readFiles({ '.changeset/a.md': protocolChangeset, '.changeset/pre/b.md': protocolChangeset, '.changeset/pre/c.md': protocolChangeset }),
  releaseAudit
);
assert.deepStrictEqual(violations, [], 'Release-audit branches can mix root edits with archive edits and deletes');

violations = findChangesetProtocolScopeViolations([{ status: 'A', paths: [archivedPath] }], archivedHead, noFiles, releaseAudit);
assert.ok(archivedOnly(violations), 'Release-audit branches cannot add to the archive');

violations = findChangesetProtocolScopeViolations(
  [{ status: 'R100', paths: ['.changeset/x.md', archivedPath] }], archivedHead, archivedBase, releaseAudit
);
assert.ok(archivedOnly(violations), 'Release-audit branches cannot rename into the archive');

violations = findChangesetProtocolScopeViolations(
  [{ status: 'R100', paths: ['.changeset/pre/a.md', '.changeset/pre/b.md'] }], archivedHead, archivedBase, releaseAudit
);
assert.deepStrictEqual(
  violations.map(v => [v.kind, v.filePath]),
  [['archived', '.changeset/pre/a.md'], ['archived', '.changeset/pre/b.md']],
  'Release-audit branches cannot rename within the archive (one violation per archived path)'
);

// The release-audit/ carve-out needs a changeset-only diff. Mixed with a protocol
// change, the archive edit fails; any root changesets in it follow the ordinary rules.
violations = findChangesetProtocolScopeViolations(
  [
    { status: 'M', paths: [archivedPath] },
    { status: 'M', paths: [protocolSourcePath] },
  ],
  archivedHead,
  archivedBase,
  releaseAudit
);
assert.ok(archivedOnly(violations), 'Release-audit: archive edit mixed with a protocol change fails with one archived violation');

violations = findChangesetProtocolScopeViolations(
  [
    { status: 'M', paths: [archivedPath] },
    { status: 'M', paths: ['server/src/billing/subscription-sync.ts'] },
  ],
  archivedHead,
  archivedBase,
  releaseAudit
);
assert.ok(archivedOnly(violations), 'Release-audit: archive edit mixed with non-changeset files fails with one archived violation');

// Version Packages branches
for (const headRef of ['changeset-release/main', 'changeset-release/3.2.x']) {
  violations = findChangesetProtocolScopeViolations(
    [
      { status: 'R100', paths: ['.changeset/a.md', '.changeset/pre/a.md'] },
      { status: 'R100', paths: ['.changeset/b.md', '.changeset/pre/b.md'] },
      { status: 'A', paths: ['dist/schemas/3.3.0-beta.6/core/product.json'] },
      { status: 'M', paths: ['CHANGELOG.md'] },
      { status: 'M', paths: ['package.json'] },
    ],
    noFiles, noFiles, { headRef }
  );
  assert.deepStrictEqual(violations, [], `${headRef}: a beta cut moving changesets into the archive passes`);
}

const gaCut = [
  { status: 'D', paths: ['.changeset/pre/a.md'] },
  { status: 'D', paths: ['.changeset/pre/b.md'] },
  { status: 'D', paths: ['.changeset/c.md'] },
  { status: 'D', paths: ['.changeset/pre.json'] },
  { status: 'A', paths: ['dist/schemas/3.3.0/core/product.json'] },
];
violations = findChangesetProtocolScopeViolations(gaCut, noFiles, noFiles, { headRef: 'changeset-release/main' });
assert.deepStrictEqual(violations, [], 'Version Packages GA cut deleting the archive passes');

violations = findArchivedChangesetViolations(gaCut, 'fix/not-version-packages');
assert.deepStrictEqual(
  violations.map(v => v.filePath),
  ['.changeset/pre/a.md', '.changeset/pre/b.md'],
  'Outside Version Packages the GA-cut shape yields one archived violation per archived path'
);

// formatViolationMessage
const mixedMessage = formatViolationMessage([
  { kind: 'archived', filePath: archivedPath, status: 'M' },
  { filePath: '.changeset/app-fix.md', message: 'pending detail' },
]);
assert.ok(mixedMessage.includes('Archived prerelease changeset changed:'), 'Message has the archived section');
assert.ok(mixedMessage.includes('Non-protocol changeset detected:'), 'Message keeps the pending section');
assert.ok(mixedMessage.includes(archivedPath) && mixedMessage.includes('release-audit/'), 'Archived section names the path and release-audit/');

// pre.json is deliberately not guarded
violations = findChangesetProtocolScopeViolations(
  [{ status: 'M', paths: ['.changeset/pre.json'] }], noFiles, noFiles, { headRef: 'fix/pre-exit' }
);
assert.deepStrictEqual(violations, [], 'Pre-exit (M pre.json) passes on an ordinary branch');
violations = findChangesetProtocolScopeViolations(
  [{ status: 'A', paths: ['.changeset/pre.json'] }], noFiles, noFiles, { headRef: 'fix/pre-enter' }
);
assert.deepStrictEqual(violations, [], 'Pre-enter (A pre.json) passes on an ordinary branch');

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
    { status: 'M', paths: ['.github/workflows/release.yml'] },
    { status: 'M', paths: ['tests/release-workflow-immutability.test.cjs'] },
    { status: 'M', paths: ['scripts/check-changeset-protocol-scope.cjs'] },
    { status: 'M', paths: ['tests/changeset-protocol-scope.test.cjs'] },
  ]),
  true,
  'Release workflow maintenance can bypass changesets status without creating a package release'
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

// `git diff --name-status -z` output arrives unquoted, so archive paths with
// non-ASCII, quote, tab or backslash characters are still recognised.
const zChanges = parseNameStatus(
  'A\0.changeset/pre/café.md\0A\0.changeset/pre/q"t.md\0A\0.changeset/pre/t\tab.md\0'
  + 'A\0.changeset/pre/a\\b.md\0R100\0.changeset/x.md\0.changeset/pre/x.md\0M\0server/src/app.ts\0'
);
assert.deepStrictEqual(
  zChanges.map(change => change.status),
  ['A', 'A', 'A', 'A', 'R100', 'M'],
  'NUL-delimited name-status parses one record per change, renames included'
);
assert.deepStrictEqual(zChanges[4].paths, ['.changeset/x.md', '.changeset/pre/x.md'], 'A NUL-delimited rename keeps both paths');
assert.strictEqual(
  findArchivedChangesetViolations(zChanges, 'fix/some-change').length,
  5,
  'Every unusual archive file name in NUL-delimited output is guarded'
);

// End to end against real Git: the CLI must read unquoted paths and take the
// head ref from CHANGESET_SCOPE_HEAD_REF, which CI sets empty for fork heads.
// Every git child and the CLI run with fixtureEnv(), so the caller's GIT_*
// variables, hooks and signing config never reach the fixture.
{
  const { execFileSync, spawnSync } = require('child_process');
  const crypto = require('crypto');
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const { fixtureEnv } = require('./helpers/git-object-fixture.cjs');

  const script = path.join(__dirname, '..', 'scripts', 'check-changeset-protocol-scope.cjs');
  const gitIn = (cwd, ...args) => execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: fixtureEnv(),
  }).trim();

  function checkScopeEndToEnd() {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'changeset-scope-'));
    const git = (...args) => gitIn(repo, ...args);
    const write = (file, content) => {
      fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      fs.writeFileSync(path.join(repo, file), content);
    };
    const runAs = (headRef, base) => spawnSync(process.execPath, [script, base], {
      cwd: repo, encoding: 'utf8', env: { ...fixtureEnv(), CHANGESET_SCOPE_HEAD_REF: headRef },
    }).status;

    try {
      git('init', '-q');
      write('.changeset/pre/existing.md', protocolChangeset);
      git('add', '-A');
      git('commit', '-qm', 'base');
      const base = git('rev-parse', 'HEAD');
      // Name the local branch like an audit, so an empty head ref must not fall
      // back to it.
      git('checkout', '-q', '-b', 'release-audit/3.3.0');

      write('.changeset/pre/café.md', protocolChangeset);
      git('add', '-A');
      git('commit', '-qm', 'add a non-ASCII archive file');
      assert.strictEqual(runAs('fix/some-change', base), 1, 'The CLI catches an added non-ASCII archive file that git would quote');

      git('reset', '-q', '--hard', base);
      write('.changeset/pre/existing.md', rewordedProtocolChangeset);
      git('commit', '-qam', 'reword an archived changeset');
      assert.strictEqual(runAs('release-audit/3.3.0', base), 0, 'The CLI honours a trusted release-audit/ head ref');
      assert.strictEqual(runAs('', base), 1, 'The CLI grades an archive edit as ordinary when the head ref is empty (a fork head in CI)');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }

  checkScopeEndToEnd();

  // Under a caller's GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE (a hook or a
  // Git-aware wrapper), the fixture must leave the caller's repository alone.
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'changeset-scope-parent-'));
  const parentIndex = path.join(parent, '.git', 'index');
  const indexSha = () => crypto.createHash('sha256').update(fs.readFileSync(parentIndex)).digest('hex');
  const inherited = { GIT_DIR: path.join(parent, '.git'), GIT_WORK_TREE: parent, GIT_INDEX_FILE: parentIndex };
  const saved = Object.fromEntries(Object.keys(inherited).map(key => [key, process.env[key]]));
  try {
    gitIn(parent, 'init', '-q');
    fs.writeFileSync(path.join(parent, 'parent.txt'), 'parent\n');
    gitIn(parent, 'add', 'parent.txt');
    gitIn(parent, 'commit', '-qm', 'parent');
    fs.writeFileSync(path.join(parent, 'sentinel.txt'), 'untracked\n');
    const before = {
      head: gitIn(parent, 'rev-parse', 'HEAD'),
      branch: gitIn(parent, 'symbolic-ref', 'HEAD'),
      status: gitIn(parent, 'status', '--porcelain'),
      index: indexSha(),
    };

    Object.assign(process.env, inherited);
    try {
      checkScopeEndToEnd();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    assert.deepStrictEqual(
      {
        head: gitIn(parent, 'rev-parse', 'HEAD'),
        branch: gitIn(parent, 'symbolic-ref', 'HEAD'),
        status: gitIn(parent, 'status', '--porcelain'),
        index: indexSha(),
      },
      before,
      "The real-Git fixture leaves a caller's HEAD, branch, index and untracked files unchanged"
    );
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

console.log('Changeset protocol scope tests passed.');
