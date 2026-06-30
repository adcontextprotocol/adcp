#!/usr/bin/env node

const { execFileSync } = require('child_process');

const CHANGESET_FILE_RE = /^\.changeset\/[^/]+[.]md$/;
const PROTOCOL_CHANGESET_RE = /^["']adcontextprotocol["']\s*:\s*(major|minor|patch)\s*$/m;
const PROTOCOL_BUMP_RANK = new Map([
  [null, 0],
  ['patch', 1],
  ['minor', 2],
  ['major', 3],
]);

const REGISTRY_RELEASE_SCOPED_PATHS = [
  /^static\/registry\//,
  /^static\/openapi\/registry[.]yaml$/,
  /^docs\/registry\//,
  /^mintlify-docs\/registry\//,
];

const PROTOCOL_SCOPED_PATHS = [
  /^static\/schemas\/source\//,
  /^static\/compliance\/source\//,
  /^docs\/reference\//,
  /^mintlify-docs\/reference\//,
  /^dist\/(?:schemas|compliance)\//,
  /^dist\/protocol\/[^/]+[.]tgz(?:[.](?:sha256|sig|crt))?$/,
  /^scripts\/(?:build-schemas|build-compliance|build-protocol-tarball|sign-protocol-tarball|stage-sdk-schema-bundle|overlay-compliance-cache|update-schema-versions|verify-version-sync|patch-3-0-compat-bundle)[.](?:cjs|mjs|sh)$/,
  /^scripts\/(?:run-storyboards-[^/]+|run-storyboards-matrix)[.]sh$/,
  /^[.]github\/workflows\/(?:release|training-agent-storyboards)[.]yml$/,
];

const CHANGESET_POLICY_CODE_PATHS = new Set([
  '.github/workflows/changeset-check.yml',
  'scripts/check-changeset-protocol-scope.cjs',
  'tests/changeset-protocol-scope.test.cjs',
]);

const CHANGESET_STATUS_EXEMPT_MAINTENANCE_PATHS = new Set([
  ...CHANGESET_POLICY_CODE_PATHS,
  '.agents/playbook.md',
  '.agents/routines/context-refresh-prompt.md',
  '.agents/routines/triage-prompt.md',
  '.agents/shortcuts/cut-beta.md',
  '.agents/shortcuts/cut-major.md',
  '.agents/shortcuts/cut-patch.md',
  '.agents/shortcuts/prep-empty.md',
  '.agents/shortcuts/prep-for-pr.md',
  'docs/reference/changelog.mdx',
  'docs/spec-guidelines.md',
]);

function normalizePath(filePath) {
  return String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function parseNameStatus(output) {
  return String(output || '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const parts = line.split('\t');
      const status = parts[0];
      if (status.startsWith('R') || status.startsWith('C')) {
        return { status, paths: [parts[1], parts[2]].filter(Boolean).map(normalizePath) };
      }
      return { status, paths: [parts[1]].filter(Boolean).map(normalizePath) };
    });
}

function isChangesetFile(filePath) {
  return CHANGESET_FILE_RE.test(normalizePath(filePath));
}

function changesetTargetsProtocol(content) {
  return changesetProtocolBump(content) !== null;
}

function changesetProtocolBump(content) {
  const match = String(content || '').match(PROTOCOL_CHANGESET_RE);
  return match ? match[1] : null;
}

function protocolBumpRank(bump) {
  return PROTOCOL_BUMP_RANK.get(bump ?? null) ?? 0;
}

function isProtocolScopedPath(filePath) {
  const normalized = normalizePath(filePath);
  if (isChangesetFile(normalized)) return false;
  if (REGISTRY_RELEASE_SCOPED_PATHS.some(pattern => pattern.test(normalized))) return false;
  return PROTOCOL_SCOPED_PATHS.some(pattern => pattern.test(normalized));
}

function hasProtocolScopedChanges(changes) {
  return changes.some(change => (change.paths || []).some(isProtocolScopedPath));
}

function isChangesetMaintenancePath(filePath) {
  const normalized = normalizePath(filePath);
  return isChangesetFile(normalized) || CHANGESET_POLICY_CODE_PATHS.has(normalized);
}

function isChangesetEditOnlyMaintenance(changes) {
  let editedExistingChangeset = false;

  for (const change of changes) {
    for (const filePath of change.paths || []) {
      const normalized = normalizePath(filePath);

      if (!isChangesetMaintenancePath(normalized)) return false;

      if (isChangesetFile(normalized)) {
        if (change.status === 'A') return false;
        if (change.status !== 'M' && change.status !== 'D') return false;
        if (change.status === 'M') editedExistingChangeset = true;
      }
    }
  }

  return editedExistingChangeset;
}

function isChangesetBumpDowngradeOrRemoval(baseContent, headContent) {
  return protocolBumpRank(changesetProtocolBump(headContent)) < protocolBumpRank(changesetProtocolBump(baseContent));
}

function isChangesetBumpEscalation(baseContent, headContent) {
  return protocolBumpRank(changesetProtocolBump(headContent)) > protocolBumpRank(changesetProtocolBump(baseContent));
}

function isChangesetClassificationMaintenance(changes, readFileAtHead, readFileAtBase) {
  if (!isChangesetEditOnlyMaintenance(changes)) return false;

  let hasDowngradeOrRemoval = false;

  for (const change of changes) {
    for (const filePath of change.paths || []) {
      const normalized = normalizePath(filePath);
      if (!isChangesetFile(normalized)) continue;
      if (change.status === 'D') continue;
      if (change.status !== 'M') return false;

      const headContent = readFileAtHead(normalized);
      const baseContent = readFileAtBase(normalized);

      if (isChangesetBumpEscalation(baseContent, headContent)) {
        return false;
      }

      if (isChangesetBumpDowngradeOrRemoval(baseContent, headContent)) {
        hasDowngradeOrRemoval = true;
        continue;
      }

      if (changesetTargetsProtocol(headContent)) {
        return false;
      }
    }
  }

  return hasDowngradeOrRemoval;
}

function isChangesetDeleteOnlyCleanup(changes) {
  let deletedChangeset = false;

  for (const change of changes) {
    for (const filePath of change.paths || []) {
      if (isChangesetFile(filePath)) {
        if (change.status !== 'D') return false;
        deletedChangeset = true;
        continue;
      }

      if (!CHANGESET_POLICY_CODE_PATHS.has(normalizePath(filePath))) {
        return false;
      }
    }
  }

  return deletedChangeset;
}

function isChangesetStatusExemptMaintenance(changes) {
  let exemptChange = false;

  for (const change of changes) {
    for (const filePath of change.paths || []) {
      const normalized = normalizePath(filePath);

      if (isChangesetFile(normalized)) {
        if (change.status !== 'D') return false;
        exemptChange = true;
        continue;
      }

      if (!CHANGESET_STATUS_EXEMPT_MAINTENANCE_PATHS.has(normalized)) {
        return false;
      }

      exemptChange = true;
    }
  }

  return exemptChange;
}


function changedPathForHead(change) {
  if (!change || change.status === 'D') return null;
  return change.paths[change.paths.length - 1] || null;
}

function findChangesetProtocolScopeViolations(changes, readFileAtHead, readFileAtBase = () => '') {
  const changesetFiles = [];
  const protocolScopedFiles = [];

  for (const change of changes) {
    for (const filePath of change.paths || []) {
      if (isProtocolScopedPath(filePath)) {
        protocolScopedFiles.push(filePath);
      }
    }

    const headPath = changedPathForHead(change);
    if (!headPath || !isChangesetFile(headPath)) continue;

    const content = readFileAtHead(headPath);
    changesetFiles.push({
      filePath: headPath,
      targetsProtocol: changesetTargetsProtocol(content),
    });
  }

  if (protocolScopedFiles.length === 0 && isChangesetClassificationMaintenance(changes, readFileAtHead, readFileAtBase)) {
    return [];
  }

  if (changesetFiles.length === 0 || protocolScopedFiles.length > 0) {
    return [];
  }

  return changesetFiles.map(changeset => ({
    filePath: changeset.filePath,
    message: changeset.targetsProtocol
      ? 'Protocol changesets are only allowed when the PR also changes protocol schemas, compliance assets, normative reference docs, release scripts, or versioned dist artifacts.'
      : 'Empty/non-package changesets are not allowed for non-protocol PRs. Remove the changeset file instead.',
  }));
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function readFileAtHead(filePath) {
  return git(['show', `HEAD:${filePath}`]);
}

function readFileAtRef(ref, filePath) {
  return git(['show', `${ref}:${filePath}`]);
}

function defaultBaseRef() {
  if (process.env.CHANGESET_SCOPE_BASE) return process.env.CHANGESET_SCOPE_BASE;
  if (process.env.GITHUB_EVENT_NAME === 'pull_request' && process.env.GITHUB_BASE_REF) {
    return `origin/${process.env.GITHUB_BASE_REF}`;
  }
  return 'origin/main';
}

function formatViolationMessage(violations) {
  return [
    'Non-protocol changeset detected:',
    ...violations.map(v => `  - ${v.filePath}`),
    '',
    'Do not add .changeset files for app, site, billing, admin, or operational-only changes.',
    violations[0]?.message,
  ]
    .filter(Boolean)
    .join('\n');
}

function run(argv = process.argv.slice(2)) {
  const baseRef = argv[0] || defaultBaseRef();
  const diffOutput = git(['diff', '--name-status', '--find-renames', `${baseRef}...HEAD`]);
  const changes = parseNameStatus(diffOutput);

  if (argv.includes('--is-delete-only-cleanup')) {
    const isCleanup = isChangesetDeleteOnlyCleanup(changes);
    if (isCleanup) {
      console.log('Changeset delete-only cleanup detected.');
      return 0;
    }
    console.log('Not a changeset delete-only cleanup.');
    return 1;
  }

  if (argv.includes('--is-status-exempt-maintenance')) {
    const isExempt = isChangesetStatusExemptMaintenance(changes);
    if (isExempt) {
      console.log('Changeset status-exempt maintenance detected.');
      return 0;
    }
    console.log('Not changeset status-exempt maintenance.');
    return 1;
  }

  if (argv.includes('--has-protocol-scoped-changes')) {
    const hasProtocol = hasProtocolScopedChanges(changes);
    if (hasProtocol) {
      console.log('Protocol-scoped changes detected.');
      return 0;
    }
    console.log('No protocol-scoped changes detected.');
    return 1;
  }

  const violations = findChangesetProtocolScopeViolations(
    changes,
    readFileAtHead,
    filePath => readFileAtRef(baseRef, filePath)
  );

  if (violations.length > 0) {
    console.error(formatViolationMessage(violations));
    return 1;
  }

  console.log('Changeset protocol scope check passed.');
  return 0;
}

if (require.main === module) {
  process.exitCode = run();
}

module.exports = {
  changesetProtocolBump,
  changesetTargetsProtocol,
  findChangesetProtocolScopeViolations,
  formatViolationMessage,
  hasProtocolScopedChanges,
  isChangesetBumpDowngradeOrRemoval,
  isChangesetBumpEscalation,
  isChangesetClassificationMaintenance,
  isChangesetDeleteOnlyCleanup,
  isChangesetEditOnlyMaintenance,
  isChangesetStatusExemptMaintenance,
  isProtocolScopedPath,
  parseNameStatus,
  run,
};
