#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const crypto = require('crypto');
const YAML = require('yaml');

const repoRoot = path.join(__dirname, '..');
const changesetsActionSha = '198f833dd7d863100ea6e28967bc9a9fdefadb0a';
const changesetsActionFixtureDir = path.join(
  repoRoot,
  'tests/fixtures/changesets-action-v2.1.0'
);
const workflowPath = path.join(repoRoot, '.github/workflows/release.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const workflowConfig = YAML.parse(workflow);
const eolReleaseBranches = ['2.5-maintenance', '2.6.x'];
const activeWorkflowPaths = [
  'apps-web-check.yml',
  'broken-links.yml',
  'build-check.yml',
  'changeset-check.yml',
  'check-testable-snippets.yml',
  'release.yml',
];
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
const changesetsStep = extractStep('Create Release Pull Request or Tag Release');
const uploadStep = extractStep('Upload protocol tarball to GitHub Release');
const changesetsStepConfig = workflowConfig.jobs.release.steps.find(
  step => step.name === 'Create Release Pull Request or Tag Release'
);
const changesetsActionContractSource = fs.readFileSync(
  path.join(changesetsActionFixtureDir, 'action.yml'),
  'utf8'
);
const changesetsActionImplementation = fs.readFileSync(
  path.join(changesetsActionFixtureDir, 'src-index.ts'),
  'utf8'
);
const changesetsActionContract = YAML.parse(changesetsActionContractSource);

assert.strictEqual(
  crypto.createHash('sha256').update(changesetsActionContractSource).digest('hex'),
  'e3277ecb13148921adcfbc29971acb12b10ece79e7de24a200ba56dff1f6a1d7',
  'Vendored action.yml must match changesets/action v2.1.0 at the pinned commit.'
);

assert.strictEqual(
  crypto.createHash('sha256').update(changesetsActionImplementation).digest('hex'),
  '012ab4141d8a1bd5db441a696fc408e5d92513a6a2be8493de72960f7b41ff30',
  'Vendored src/index.ts must match changesets/action v2.1.0 at the pinned commit.'
);

for (const branch of eolReleaseBranches) {
  for (const workflowName of activeWorkflowPaths) {
    const source = fs.readFileSync(
      path.join(repoRoot, '.github/workflows', workflowName),
      'utf8'
    );
    assert(
      !source.includes(branch),
      `${workflowName} must not target end-of-life v2 branch ${branch}.`
    );
  }
}

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
  changesetsStep.includes("HUSKY: '0'"),
  'Changesets automation must not rerun local pre-commit hooks while creating its release commit.'
);

assert.deepStrictEqual(
  changesetsStepConfig,
  {
    name: 'Create Release Pull Request or Tag Release',
    if: "steps.release-relevance.outputs.relevant == 'true' && steps.release-artifacts.outputs.has_release_artifacts != 'true'",
    id: 'changesets',
    uses: `changesets/action@${changesetsActionSha}`,
    with: {
      'github-token': '${{ steps.app-token.outputs.token }}',
      'version-script': 'npm run version',
      'publish-script': 'npx --no-install changeset git-tag',
      'commit-message': 'Version Packages',
      'pr-title': 'Version Packages',
      'create-github-releases': true,
      'push-with-git-cli': true,
    },
    env: {
      HUSKY: '0',
    },
  },
  'Release automation must preserve the pinned Changesets v2.1.0 input contract and git-CLI push mode.'
);

for (const inputName of Object.keys(changesetsStepConfig.with)) {
  assert(
    Object.hasOwn(changesetsActionContract.inputs, inputName),
    `Pinned Changesets action does not declare configured input: ${inputName}`
  );
}

assert(
  changesetsActionImplementation.includes('getRequiredInput("github-token")'),
  'Pinned Changesets action must read the configured GitHub App token input.'
);

assert(
  changesetsActionImplementation.includes('core.getBooleanInput("push-with-git-cli")'),
  'Pinned Changesets action must implement the configured git-CLI push mode.'
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
