#!/usr/bin/env node

const { execFileSync } = require('child_process');

const CHANGESET_FILE_RE = /^\.changeset\/[^/]+[.]md$/;
const PROTOCOL_CHANGESET_RE = /^["']adcontextprotocol["']\s*:\s*(major|minor|patch)\s*$/m;

const PROTOCOL_SCOPED_PATHS = [
  /^static\/schemas\/source\//,
  /^static\/compliance\/source\//,
  /^static\/registry\//,
  /^docs\/reference\//,
  /^mintlify-docs\/reference\//,
  /^dist\/(?:schemas|compliance)\//,
  /^dist\/protocol\/[^/]+[.]tgz(?:[.](?:sha256|sig|crt))?$/,
  /^scripts\/(?:build-schemas|build-compliance|build-protocol-tarball|sign-protocol-tarball|stage-sdk-schema-bundle|overlay-compliance-cache|update-schema-versions|verify-version-sync|patch-3-0-compat-bundle)[.](?:cjs|mjs|sh)$/,
  /^scripts\/(?:run-storyboards-[^/]+|run-storyboards-matrix)[.]sh$/,
  /^[.]github\/workflows\/(?:release|training-agent-storyboards)[.]yml$/,
];

const CHANGESET_POLICY_MAINTENANCE_PATHS = new Set([
  '.github/workflows/changeset-check.yml',
  'scripts/check-changeset-protocol-scope.cjs',
  'tests/changeset-protocol-scope.test.cjs',
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
  return PROTOCOL_CHANGESET_RE.test(String(content || ''));
}

function isProtocolScopedPath(filePath) {
  const normalized = normalizePath(filePath);
  if (isChangesetFile(normalized)) return false;
  return PROTOCOL_SCOPED_PATHS.some(pattern => pattern.test(normalized));
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

      if (!CHANGESET_POLICY_MAINTENANCE_PATHS.has(normalizePath(filePath))) {
        return false;
      }
    }
  }

  return deletedChangeset;
}


function changedPathForHead(change) {
  if (!change || change.status === 'D') return null;
  return change.paths[change.paths.length - 1] || null;
}

function findChangesetProtocolScopeViolations(changes, readFileAtHead) {
  const protocolChangesets = [];
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
    if (changesetTargetsProtocol(content)) {
      protocolChangesets.push(headPath);
    }
  }

  if (protocolChangesets.length === 0 || protocolScopedFiles.length > 0) {
    return [];
  }

  return protocolChangesets.map(filePath => ({
    filePath,
    message:
      'Protocol changesets are only allowed when the PR also changes protocol schemas, compliance assets, normative reference docs, release scripts, or versioned dist artifacts.',
  }));
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function readFileAtHead(filePath) {
  return git(['show', `HEAD:${filePath}`]);
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
    'Do not add an adcontextprotocol changeset for app, site, billing, admin, or operational-only changes.',
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

  const violations = findChangesetProtocolScopeViolations(changes, readFileAtHead);

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
  changesetTargetsProtocol,
  findChangesetProtocolScopeViolations,
  formatViolationMessage,
  isChangesetDeleteOnlyCleanup,
  isProtocolScopedPath,
  parseNameStatus,
  run,
};
