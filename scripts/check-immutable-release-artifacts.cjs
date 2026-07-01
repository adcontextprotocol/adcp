#!/usr/bin/env node

const { execFileSync } = require('child_process');

const SEMVER_PATTERN = String.raw`\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?`;
const VERSIONED_DIR_RE = new RegExp(
  `^dist/(schemas|compliance|docs)/(${SEMVER_PATTERN})(?:/|$)`
);
const PROTOCOL_ARTIFACT_RE = new RegExp(
  `^dist/protocol/(${SEMVER_PATTERN})[.]tgz(?:[.](?:sha256|sig|crt))?$`
);

function parseImmutableArtifactPath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');

  const versionedDir = VERSIONED_DIR_RE.exec(normalized);
  if (versionedDir) {
    const [, kind, version] = versionedDir;
    return {
      kind,
      version,
      releaseRoot: `dist/${kind}/${version}`,
      probePaths: [`dist/${kind}/${version}`],
    };
  }

  const protocolArtifact = PROTOCOL_ARTIFACT_RE.exec(normalized);
  if (protocolArtifact) {
    const [, version] = protocolArtifact;
    return {
      kind: 'protocol',
      version,
      releaseRoot: `dist/protocol/${version}`,
      probePaths: [
        `dist/protocol/${version}.tgz`,
        `dist/protocol/${version}.tgz.sha256`,
        `dist/protocol/${version}.tgz.sig`,
        `dist/protocol/${version}.tgz.crt`,
      ],
    };
  }

  return null;
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
        return { status, paths: [parts[1], parts[2]].filter(Boolean) };
      }
      return { status, paths: [parts[1]].filter(Boolean) };
    });
}

function findImmutableArtifactViolations(changes, hasPathAtBase, isReleasedVersion = () => true) {
  const violations = [];

  for (const change of changes) {
    for (const filePath of change.paths || []) {
      const artifact = parseImmutableArtifactPath(filePath);
      if (!artifact) continue;

      const existedAtBase = artifact.probePaths.some(hasPathAtBase);
      if (!existedAtBase) continue;
      if (!isReleasedVersion(artifact.version)) continue;

      violations.push({
        status: change.status,
        path: filePath,
        releaseRoot: artifact.releaseRoot,
      });
    }
  }

  return violations;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function pathExistsAtRef(ref, repoPath) {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:${repoPath}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function versionHasGitTag(version) {
  try {
    execFileSync('git', ['rev-parse', '-q', '--verify', `refs/tags/v${version}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function defaultBaseRef() {
  if (process.env.IMMUTABLE_ARTIFACT_BASE) return process.env.IMMUTABLE_ARTIFACT_BASE;
  if (process.env.GITHUB_EVENT_NAME === 'pull_request' && process.env.GITHUB_BASE_REF) {
    return `origin/${process.env.GITHUB_BASE_REF}`;
  }
  return 'origin/main';
}

function formatViolationMessage(violations) {
  const lines = [
    'Immutable released artifact edits detected:',
    ...violations.map(v => `  - ${v.status} ${v.path}`),
    '',
    'Do not patch existing versioned dist artifacts in-place.',
    'Change the source files, add a changeset, and ship a new versioned artifact through Version Packages (`npm run version`).',
    'Mutable development outputs such as dist/*/latest are allowed; existing dist/*/<semver> releases are not.',
  ];
  return lines.join('\n');
}

function run(argv = process.argv.slice(2)) {
  const baseRef = argv[0] || defaultBaseRef();
  const diffOutput = git(['diff', '--name-status', '--find-renames', `${baseRef}...HEAD`]);
  const changes = parseNameStatus(diffOutput);
  const violations = findImmutableArtifactViolations(
    changes,
    repoPath => pathExistsAtRef(baseRef, repoPath),
    versionHasGitTag
  );

  if (violations.length > 0) {
    console.error(formatViolationMessage(violations));
    return 1;
  }

  console.log('Immutable release artifact check passed.');
  return 0;
}

if (require.main === module) {
  process.exitCode = run();
}

module.exports = {
  findImmutableArtifactViolations,
  formatViolationMessage,
  parseImmutableArtifactPath,
  parseNameStatus,
  run,
};
