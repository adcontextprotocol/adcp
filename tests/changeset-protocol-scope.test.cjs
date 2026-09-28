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
assert.strictEqual(isProtocolScopedPath('scripts/run-storyboards-isolated.mjs'), true);
assert.strictEqual(isProtocolScopedPath('server/src/billing/subscription-sync.ts'), false);
assert.strictEqual(isProtocolScopedPath('.changeset/billing-fix.md'), false);
assert.strictEqual(isProtocolScopedPath('.github/workflows/release.yml'), false);
assert.strictEqual(isProtocolScopedPath('.github/workflows/training-agent-storyboards.yml'), true);
assert.strictEqual(isProtocolScopedPath('scripts/build-protocol-tarball.cjs'), true);
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

console.log('Changeset protocol scope tests passed.');

// Complete before/after contents are required for the exact creative runner
// substitution. Unrelated edits in these operational files remain scoped.
{
  const fs = require('node:fs');
  const path = require('node:path');
  const replacements = {
    'scripts/run-storyboards-matrix.sh': [[
      '&& { [ "${tenant}" = "sales" ] || [ "${tenant}" = "creative" ]; }; }',
      '&& [ "${tenant}" = "sales" ]; }',
    ]],
    '.github/workflows/training-agent-storyboards.yml': [
      ['# matrix tenants except current /creative remain monolithic;', '# matrix tenants remain monolithic;'],
      ['if [ "${{ matrix.tenant }}" = "creative-builder" ] || { [ "${{ matrix.surface }}" = "current" ] && [ "${{ matrix.tenant }}" = "creative" ]; }; then',
        'if [ "${{ matrix.tenant }}" = "creative-builder" ]; then'],
      ['One or more isolated ${{ matrix.tenant }} orchestrators failed.', 'One or more isolated creative-builder orchestrators failed.'],
    ],
  };
  for (const [file, substitutions] of Object.entries(replacements)) {
    const head = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    let base = head;
    for (const [after, before] of substitutions) {
      assert.ok(base.includes(after));
      base = base.replace(after, before);
    }
    const changes = [{ status: 'M', paths: [file] }];
    const classify = (candidate = head, prior = base, delta = changes) =>
      hasProtocolScopedChanges(delta, readFiles({ [file]: candidate }), readFiles({ [file]: prior }));
    assert.strictEqual(classify(), false, `${file}: exact isolation substitution is operational`);
    assert.strictEqual(hasProtocolScopedChanges(changes), true, 'path-only queries fail closed');
    assert.strictEqual(classify(head, ''), true, 'missing base fails closed');
    assert.strictEqual(classify('', base), true, 'missing head fails closed');
    assert.strictEqual(hasProtocolScopedChanges(changes, () => { throw new Error('unreadable'); }, () => base), true);
    assert.strictEqual(classify(head, head), true, 'an absent substitution cannot exempt other edits');
    assert.strictEqual(classify(head + '\n', base), true, 'extra edits fail closed');
    assert.strictEqual(classify(head, base + base), true, 'ambiguous substitution fails closed');
    for (const status of ['A', 'D', 'R100', 'C100']) {
      assert.strictEqual(classify(head, base, [{ status, paths: [file] }]), true, status);
    }
    assert.strictEqual(classify(head, base, [{ status: 'R100', paths: ['previous.sh', file] }]), true);
    for (const [before, after] of [['209', '208'], ['49', '48'], ['--shard-count 8', '--shard-count 1'],
      ['PUBLIC_TEST_AGENT_TOKEN', 'REPLACED_TOKEN'], ['orchestrator_failure=1', 'orchestrator_failure=0']]) {
      assert.ok(head.includes(before));
      assert.strictEqual(classify(head.replace(before, after)), true, `${file}: ${before} must remain scoped`);
    }
    const mixed = [...changes, { status: 'M', paths: ['static/compliance/source/universal/security.yaml'] }];
    assert.strictEqual(classify(head, base, mixed), true, 'mixed protocol changes still require changesets');
    for (const content of [protocolChangeset, emptyChangeset]) {
      const withChangeset = [...changes, { status: 'A', paths: ['.changeset/unnecessary.md'] }];
      assert.strictEqual(findChangesetProtocolScopeViolations(withChangeset,
        readFiles({ [file]: head, '.changeset/unnecessary.md': content }), readFiles({ [file]: base })).length, 1,
      'operational substitution rejects gratuitous protocol and empty changesets');
    }
    // A separately landed npm-ci substitution may be present identically on
    // both sides, but this exemption cannot absorb it into the same delta.
    assert.strictEqual(classify(head.replaceAll('run: npm ci', 'run: node .github/scripts/npm-ci.mjs'),
      base.replaceAll('run: npm ci', 'run: node .github/scripts/npm-ci.mjs')), false);
    if (file.endsWith('.yml')) assert.strictEqual(classify(head.replaceAll('run: npm ci', 'run: node .github/scripts/npm-ci.mjs')), true);
  }
  assert.strictEqual(hasProtocolScopedChanges([{ status: 'M', paths: ['.github/workflows/release.yml'] }], () => '', () => ''), true);
}

// Verify the actual CLI reads the diff's merge base, including when main has
// advanced independently. Neither query nor changeset rejection may regress to
// a path-only classification after the unit-level exemption succeeds.
{
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { execFileSync, spawnSync } = require('node:child_process');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'creative-scope-cli-'));
  const git = (...args) => execFileSync('git', args, { cwd: directory, stdio: 'pipe' }).toString().trim();
  const checker = path.resolve(__dirname, '../scripts/check-changeset-protocol-scope.cjs');
  const file = 'scripts/run-storyboards-matrix.sh';
  const head = fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8');
  const base = head.replace('&& { [ "${tenant}" = "sales" ] || [ "${tenant}" = "creative" ]; }; }',
    '&& [ "${tenant}" = "sales" ]; }');
  const check = (...args) => spawnSync(process.execPath, [checker, 'main', ...args], { cwd: directory, encoding: 'utf8' });
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Scope fixture');
    git('config', 'user.email', 'scope@example.test');
    git('config', 'core.hooksPath', '/dev/null');
    fs.mkdirSync(path.join(directory, 'scripts'));
    fs.writeFileSync(path.join(directory, file), base);
    git('add', '.'); git('commit', '-m', 'base');
    git('checkout', '-b', 'candidate');
    fs.writeFileSync(path.join(directory, file), head);
    git('add', '.'); git('commit', '-m', 'isolate creative');
    assert.strictEqual(check('--has-protocol-scoped-changes').status, 1);
    assert.strictEqual(check().status, 0);
    git('checkout', 'main');
    fs.appendFileSync(path.join(directory, file), '\n# independent main edit\n');
    git('add', '.'); git('commit', '-m', 'advance main');
    git('checkout', 'candidate');
    assert.match(check('--has-protocol-scoped-changes').stdout, /No protocol-scoped changes detected/);
    fs.mkdirSync(path.join(directory, '.changeset'));
    fs.writeFileSync(path.join(directory, '.changeset/unnecessary.md'), protocolChangeset);
    git('add', '.'); git('commit', '-m', 'gratuitous bump');
    assert.strictEqual(check().status, 1);
    fs.writeFileSync(path.join(directory, file), head.replace('creative:49:209', 'creative:49:208'));
    git('add', '.'); git('commit', '-m', 'floor change');
    assert.strictEqual(check('--has-protocol-scoped-changes').status, 0);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}
