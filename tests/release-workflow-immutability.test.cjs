#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const YAML = require('yaml');

const repoRoot = path.join(__dirname, '..');
const workflowPath = path.join(repoRoot, '.github/workflows/release.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const releaseDocsWorkflowConfig = YAML.parse(fs.readFileSync(path.join(repoRoot, '.github/workflows/release-docs.yml'), 'utf8'));
const forwardMergeWorkflows = ['3.0', '3.1'].map((line) => ({
  line,
  source: fs.readFileSync(
    path.join(repoRoot, `.github/workflows/forward-merge-${line}.yml`),
    'utf8'
  ),
}));

function extractStep(name) {
  const start = workflow.indexOf(`- name: ${name}`);
  assert.notStrictEqual(start, -1, `Could not find step: ${name}`);
  const next = workflow.indexOf('\n      - name:', start + 1);
  return next === -1 ? workflow.slice(start) : workflow.slice(start, next);
}

const releaseRelevance = extractStep('Detect release-relevant push');
const artifactDetection = extractStep('Detect committed release artifacts');
const uploadStep = extractStep('Upload protocol tarball to GitHub Release');

assert(
  !releaseRelevance.includes('Release ${TAG} is missing ${asset}; running repair path.'),
  'Release workflow must not silently repair existing releases from unrelated pushes.'
);

assert(
  !artifactDetection.includes('[ -d "dist/schemas/${VERSION}" ]'),
  'Release artifact detection must not treat artifacts that merely exist in the tree as publishable.'
);

assert(
  artifactDetection.includes('grep -Eq "^dist/(schemas|compliance)/${VERSION}/|^dist/protocol/${VERSION}[.]" <<< "${changed_files}"'),
  'Release artifact detection must be based on artifact paths changed by the triggering commit.'
);

assert(
  !uploadStep.includes('--clobber'),
  'Release upload must not clobber immutable release assets.'
);

assert(
  uploadStep.includes('Release asset ${name} already exists on ${TAG}; leaving it untouched.'),
  'Release upload must skip existing assets rather than replacing them.'
);

assert(
  uploadStep.includes('local remote_name') &&
    uploadStep.includes('select(.name == \\"${name}\\") | .name') &&
    uploadStep.includes('if [ -n "${remote_name}" ]; then'),
  'Release upload must use asset name existence, not digest presence, before deciding whether to upload.'
);

for (const { line, source } of forwardMergeWorkflows) {
  const head = `forward-merge/${line}.x`;
  const pushIndex = source.indexOf(`git push --force origin "HEAD:refs/heads/${head}"`);
  // The conflict-recovery instructions also mention `gh pr create`; the last
  // occurrence is the executable PR-creation step after the branch push.
  const createIndex = source.lastIndexOf('gh pr create');

  assert.strictEqual(
    source.includes('peter-evans/create-pull-request'),
    false,
    `${line}.x forward merge must not pass its pushed merge commit to an action that rewrites the branch.`
  );
  assert.notStrictEqual(pushIndex, -1, `${line}.x forward merge must push the reviewed merge ref.`);
  assert.notStrictEqual(createIndex, -1, `${line}.x forward merge must create a PR for the pushed ref.`);
  assert(
    pushIndex < createIndex,
    `${line}.x forward merge must push its merge commit before creating the PR.`
  );
  assert(
    source.includes('GH_TOKEN: ${{ steps.app-token.outputs.token }}'),
    `${line}.x forward merge must create the PR with the release App token.`
  );
  assert(
    source.includes('--state open') &&
      source.includes('--base main') &&
      source.includes('--head "$PR_HEAD"'),
    `${line}.x forward merge must reuse an existing open PR for the maintenance head.`
  );
}

console.log('Release and forward-merge workflow checks passed.');

const { test } = require('node:test');
const documentationSnapshotStep = releaseDocsWorkflowConfig.jobs['snapshot-docs'].steps.find(step => step.name === 'Create docs snapshot');

function createDocsSnapshotFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-docs-source-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
  };
  git('init', '--quiet');
  git('config', 'user.name', 'Release fixture');
  git('config', 'user.email', 'release-fixture@example.test');
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs/stable.md'), 'Tagged release content\n');
  fs.writeFileSync(path.join(root, 'docs/.hidden.md'), 'Tagged hidden page\n');
  git('add', 'docs');
  git('commit', '--quiet', '-m', 'Tagged documentation');
  git('tag', 'v9.9.9');
  fs.writeFileSync(path.join(root, 'docs/stable.md'), 'Current main content\n');
  fs.writeFileSync(path.join(root, 'docs/future-only.md'), 'Future protocol guide\n');
  return root;
}

function runDocsSnapshotFixture(root, version, event) {
  const script = documentationSnapshotStep.run
    .replaceAll('${{ steps.version.outputs.version }}', version)
    .replaceAll('${{ github.event_name }}', event)
    .replaceAll('${{ github.ref_name }}', `v${version}`);
  assert.ok(!script.includes('${{'), 'all workflow expressions must be resolved');
  return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_EVENT_NAME: event },
  });
}

test('release and manual snapshots contain only the tagged tree and preserve live docs', t => {
  const root = createDocsSnapshotFixture(t);
  const output = path.join(root, 'dist/docs/9.9.9');
  for (const event of ['release', 'workflow_dispatch']) {
    const result = runDocsSnapshotFixture(root, '9.9.9', event);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(fs.readdirSync(output).sort(), ['.hidden.md', 'stable.md']);
    assert.strictEqual(fs.readFileSync(path.join(output, 'stable.md'), 'utf8'), 'Tagged release content\n');
    assert.strictEqual(fs.readFileSync(path.join(output, '.hidden.md'), 'utf8'), 'Tagged hidden page\n');
    assert.strictEqual(fs.readFileSync(path.join(root, 'docs/stable.md'), 'utf8'), 'Current main content\n');
    assert.strictEqual(fs.readFileSync(path.join(root, 'docs/future-only.md'), 'utf8'), 'Future protocol guide\n');
    fs.writeFileSync(path.join(output, 'stale.md'), 'An obsolete candidate file\n');
  }
});

test('an invalid source tag fails without moving or overwriting live documentation', t => {
  const root = createDocsSnapshotFixture(t);
  const result = runDocsSnapshotFixture(root, '9.9.8', 'workflow_dispatch');
  assert.notStrictEqual(result.status, 0);
  assert.strictEqual(fs.readFileSync(path.join(root, 'docs/stable.md'), 'utf8'), 'Current main content\n');
  assert.strictEqual(fs.readFileSync(path.join(root, 'docs/future-only.md'), 'utf8'), 'Future protocol guide\n');
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'dist/docs/9.9.8')), []);
});
