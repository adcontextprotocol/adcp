import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import YAML from 'yaml';

// Path checks run on bounded checkouts instead of fetching every branch and
// tag (#8559). These tests drive the real fetch logic against file:// clones
// and compare it with the answer full history gives.
const require = createRequire(import.meta.url);
const { fixtureEnv } = require('./helpers/git-object-fixture.cjs');

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FETCH_MERGE_BASE = path.join(REPO_ROOT, 'scripts', 'fetch-merge-base.sh');
const FIXTURE_TIMEOUT_MS = 60_000;
const ZERO_SHA = '0'.repeat(40);
const UNKNOWN_SHA = '1'.repeat(40);
// Main runs this many commits past the PR's base, so the merge base sits
// deeper than the first fetch window on the base side only.
const MAIN_COMMITS_AFTER_PR_BASE = 10;
// Windows sized to the fixture: the merge base is reachable within 16.
const BOUNDED_WINDOW = { FETCH_MERGE_BASE_INITIAL_DEPTH: '2', FETCH_MERGE_BASE_MAX_DEPTH: '16' };
const TOO_SMALL_WINDOW = { FETCH_MERGE_BASE_INITIAL_DEPTH: '2', FETCH_MERGE_BASE_MAX_DEPTH: '8' };
// Retries keep their real attempt counts; only the wait between them is skipped.
const NO_RETRY_DELAY = { FETCH_MERGE_BASE_RETRY_DELAY_SECONDS: '0', FETCH_RETRY_DELAY_SECONDS: '0' };
const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
// Fails one git subcommand outright, or the first N fetches, then defers to the
// real git. Git's own child processes use its exec path, so they bypass this.
const GIT_STUB = `#!/usr/bin/env bash
if [ -n "\${GIT_STUB_FAIL_SUBCOMMAND:-}" ] && [ "$1" = "\${GIT_STUB_FAIL_SUBCOMMAND}" ]; then
  echo "stub: $1 failed" >&2
  exit 128
fi
if [ "$1" = fetch ] && [ -n "\${GIT_STUB_FAILING_FETCHES:-}" ]; then
  count=$(cat "\${GIT_STUB_COUNTER}" 2>/dev/null || echo 0)
  echo $((count + 1)) > "\${GIT_STUB_COUNTER}"
  if [ "$count" -lt "\${GIT_STUB_FAILING_FETCHES}" ]; then
    echo "stub: transient fetch failure" >&2
    exit 128
  fi
fi
exec "${REAL_GIT}" "$@"
`;

const loadWorkflow = (name) =>
  YAML.parse(fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', name), 'utf8'));

const temporaryDirectories = [];
function makeTemporaryDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], env: fixtureEnv() }).trim();
}

function commitFiles(repo, message, files = {}) {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(repo, path.dirname(file)), { recursive: true });
    fs.writeFileSync(path.join(repo, file), content);
  }
  git(repo, ['add', '-A']);
  git(repo, ['commit', '-q', '--allow-empty', '-m', message]);
  return git(repo, ['rev-parse', 'HEAD']);
}

function mergeInto(repo, target, source, message) {
  git(repo, ['checkout', '-q', '--detach', target]);
  git(repo, ['merge', '-q', '--no-ff', '--no-edit', '-m', message, source]);
  return git(repo, ['rev-parse', 'HEAD']);
}

/**
 * main:    root - E(merge release R) - P - m1..m10 - J(merge release R2) - W(apps/web)
 * release: root - R - R2
 * PRs from P: H (docs only) and HW (apps/web); MERGE / MERGE_WEB are their
 * pull_request merge refs, built on P while main has since moved on.
 *
 * From the main tip, R is a few commits away through J, while P is more than
 * ten away. A shallow graph therefore offers R as a common ancestor before
 * the real merge base P is reachable.
 */
function createOrigin() {
  const repo = makeTemporaryDirectory('adcp-bounded-origin-');
  git(repo, ['init', '-q']);
  git(repo, ['checkout', '-q', '-b', 'main']);
  // Fetch by SHA and partial fetches behave as they do against GitHub.
  git(repo, ['config', 'uploadpack.allowFilter', 'true']);
  git(repo, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);

  const root = commitFiles(repo, 'root', {
    'apps/web/app.ts': 'export const app = 1;\n',
    'docs/guide.md': '# Guide\n',
    'release/notes.md': 'notes\n',
  });
  git(repo, ['checkout', '-q', '-b', 'release']);
  const releaseCommit = commitFiles(repo, 'release fix', { 'release/notes.md': 'notes 1\n' });
  const earlyForwardMerge = mergeInto(repo, root, releaseCommit, 'forward-merge release');
  const prBase = commitFiles(repo, 'main work');
  for (let index = 1; index <= MAIN_COMMITS_AFTER_PR_BASE; index += 1) {
    commitFiles(repo, `main ${index}`);
  }
  const mainBeforeForwardMerge = git(repo, ['rev-parse', 'HEAD']);

  git(repo, ['checkout', '-q', releaseCommit]);
  const laterReleaseCommit = commitFiles(repo, 'release fix 2', { 'release/notes.md': 'notes 2\n' });
  git(repo, ['branch', '-q', '-f', 'release', laterReleaseCommit]);
  const forwardMerge = mergeInto(repo, mainBeforeForwardMerge, laterReleaseCommit, 'forward-merge release 2');
  // The detector compares against the target tip, so pull request cases
  // target a branch cut before main's own apps/web change.
  git(repo, ['branch', '-q', '-f', 'before-web-push', forwardMerge]);
  const webPush = commitFiles(repo, 'web change on main', { 'apps/web/app.ts': 'export const app = 2;\n' });
  git(repo, ['branch', '-q', '-f', 'main', webPush]);

  git(repo, ['checkout', '-q', '--detach', prBase]);
  const docsHead = commitFiles(repo, 'docs change', { 'docs/guide.md': '# Guide\n\nMore.\n' });
  git(repo, ['checkout', '-q', '--detach', prBase]);
  const webHead = commitFiles(repo, 'web change', { 'apps/web/app.ts': 'export const app = 3;\n' });
  const docsMerge = mergeInto(repo, prBase, docsHead, 'Merge docs PR');
  const webMerge = mergeInto(repo, prBase, webHead, 'Merge web PR');
  git(repo, ['checkout', '-q', 'main']);
  return {
    repo,
    url: `file://${repo}`,
    shas: {
      root, releaseCommit, earlyForwardMerge, prBase, forwardMerge, webPush,
      docsHead, webHead, docsMerge, webMerge,
    },
  };
}

/** Same shape as actions/checkout with fetch-depth 1. */
function shallowCheckout(origin, sha) {
  const clone = makeTemporaryDirectory('adcp-bounded-clone-');
  git(clone, ['init', '-q']);
  git(clone, ['remote', 'add', 'origin', origin.url]);
  git(clone, ['fetch', '-q', '--no-tags', '--depth=1', 'origin', `+${sha}:refs/remotes/pull/1/merge`]);
  git(clone, ['checkout', '-q', '--detach', sha]);
  expect(git(clone, ['rev-parse', '--is-shallow-repository'])).toBe('true');
  return clone;
}

/**
 * Environment that puts the git stub first on PATH. `failSubcommand` makes
 * that subcommand fail; `failingFetches` makes the first N fetches fail.
 */
function gitStubEnv({ failSubcommand = '', failingFetches = '' } = {}) {
  const directory = makeTemporaryDirectory('adcp-git-stub-');
  fs.writeFileSync(path.join(directory, 'git'), GIT_STUB, { mode: 0o755 });
  return {
    PATH: `${directory}${path.delimiter}${process.env.PATH}`,
    GIT_STUB_FAIL_SUBCOMMAND: failSubcommand,
    GIT_STUB_FAILING_FETCHES: String(failingFetches),
    GIT_STUB_COUNTER: path.join(directory, 'fetch-count'),
  };
}

function runFetchMergeBase(clone, baseBranch, extraEnv) {
  const result = spawnSync('bash', [FETCH_MERGE_BASE, baseBranch], {
    cwd: clone,
    encoding: 'utf8',
    env: { ...fixtureEnv(), ...NO_RETRY_DELAY, ...extraEnv },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function runDetectWebChanges(clone, eventEnv, extraEnv = {}) {
  const workflow = loadWorkflow('apps-web-check.yml');
  const step = workflow.jobs.check.steps.find((candidate) => candidate.name === 'Detect web changes');
  // The step's fixed settings (retry attempts) apply as written; the
  // expression-valued ones come from each test's event.
  const fixedStepEnv = Object.fromEntries(
    Object.entries(step.env).filter(([, value]) => !String(value).includes('${{')),
  );
  const scriptFile = path.join(makeTemporaryDirectory('adcp-web-detect-'), 'detect.sh');
  const outputFile = `${scriptFile}.output`;
  fs.writeFileSync(scriptFile, step.run);
  fs.writeFileSync(outputFile, '');
  // GitHub runs an unspecified `run` shell as `bash -e {0}`.
  const result = spawnSync('bash', ['-e', scriptFile], {
    cwd: clone,
    encoding: 'utf8',
    env: {
      ...fixtureEnv(),
      ...fixedStepEnv,
      ...NO_RETRY_DELAY,
      BASE_REF_NAME: '',
      BEFORE_SHA: '',
      ...eventEnv,
      ...extraEnv,
      GITHUB_OUTPUT: outputFile,
    },
  });
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    web: fs.readFileSync(outputFile, 'utf8').trim(),
  };
}

let origin;
beforeAll(() => {
  origin = createOrigin();
}, FIXTURE_TIMEOUT_MS);

afterAll(() => {
  for (const directory of temporaryDirectories) fs.rmSync(directory, { recursive: true, force: true });
});

describe('scripts/fetch-merge-base.sh', () => {
  it('finds the full-history merge base when the base side needs deepening past a decoy ancestor', () => {
    const { prBase, docsMerge } = origin.shas;
    expect(git(origin.repo, ['merge-base', 'main', docsMerge])).toBe(prBase);

    const clone = shallowCheckout(origin, docsMerge);
    const result = runFetchMergeBase(clone, 'main', BOUNDED_WINDOW);

    expect(result.status, result.output).toBe(0);
    // Found inside the bounded window, so the base side deepened too.
    expect(result.output).toContain(`merge_base=${prBase} `);
    expect(result.output).toContain('history=depth-16');
    expect(git(clone, ['merge-base', 'origin/main', 'HEAD'])).toBe(prBase);
    expect(git(clone, ['diff', '--name-only', 'origin/main...HEAD'])).toBe(
      git(origin.repo, ['diff', '--name-only', `main...${docsMerge}`]),
    );
    expect(git(clone, ['diff', '--name-only', 'origin/main...HEAD'])).toBe('docs/guide.md');
  }, FIXTURE_TIMEOUT_MS);

  it('falls back to complete history when the window is too small', () => {
    const { prBase, docsHead } = origin.shas;
    const clone = shallowCheckout(origin, docsHead);
    const result = runFetchMergeBase(clone, 'main', TOO_SMALL_WINDOW);

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('::warning::No exact merge base within 8 commits');
    expect(result.output).toContain(`merge_base=${prBase} `);
    expect(result.output).toContain('history=complete');
    expect(git(clone, ['diff', '--name-only', 'origin/main...HEAD'])).toBe(
      git(origin.repo, ['diff', '--name-only', `main...${docsHead}`]),
    );
  }, FIXTURE_TIMEOUT_MS);

  it('fails when HEAD shares no history with the base branch', () => {
    const clone = makeTemporaryDirectory('adcp-bounded-unrelated-');
    git(clone, ['init', '-q']);
    git(clone, ['remote', 'add', 'origin', origin.url]);
    commitFiles(clone, 'unrelated');
    // The helper fetches HEAD by SHA, so the orphan commit must exist on origin.
    execFileSync('git', ['push', '-q', origin.url, 'HEAD:refs/heads/unrelated'], { cwd: clone, env: fixtureEnv() });
    git(clone, ['fetch', '-q', '--depth=1', 'origin', 'refs/heads/unrelated']);

    const result = runFetchMergeBase(clone, 'main', TOO_SMALL_WINDOW);

    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('::error::No merge base between refs/remotes/origin/main and HEAD');
    expect(result.output).not.toContain('merge_base=');
  }, FIXTURE_TIMEOUT_MS);

  it('fails instead of accepting a merge base when the commits above it cannot be listed', () => {
    const clone = shallowCheckout(origin, origin.shas.docsMerge);
    const result = runFetchMergeBase(clone, 'main', { ...BOUNDED_WINDOW, ...gitStubEnv({ failSubcommand: 'rev-list' }) });

    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('::error::Could not list the commits above merge base');
    expect(result.output).not.toContain('merge_base=');
  }, FIXTURE_TIMEOUT_MS);

  it('retries a failed fetch', () => {
    const { prBase, docsMerge } = origin.shas;
    const clone = shallowCheckout(origin, docsMerge);
    const result = runFetchMergeBase(clone, 'main', { ...BOUNDED_WINDOW, ...gitStubEnv({ failingFetches: 2 }) });

    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('::warning::git fetch failed (attempt 1 of 3)');
    expect(result.output).toContain('::warning::git fetch failed (attempt 2 of 3)');
    expect(result.output).toContain(`merge_base=${prBase} `);
  }, FIXTURE_TIMEOUT_MS);

  it('fails after the last fetch attempt', () => {
    const clone = shallowCheckout(origin, origin.shas.docsMerge);
    git(clone, ['remote', 'set-url', 'origin', `${origin.url}-missing`]);
    const result = runFetchMergeBase(clone, 'main', BOUNDED_WINDOW);

    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain('::warning::git fetch failed (attempt 2 of 3)');
    expect(result.output).toContain('::error::git fetch from origin failed after 3 attempts.');
    expect(result.output).not.toContain('merge_base=');
  }, FIXTURE_TIMEOUT_MS);

  it('rejects a missing or malformed base branch', () => {
    const clone = shallowCheckout(origin, origin.shas.docsHead);
    for (const baseBranch of ['', 'bad..name']) {
      const result = runFetchMergeBase(clone, baseBranch, BOUNDED_WINDOW);
      expect(result.status, result.output).toBe(2);
      expect(result.output).toContain('::error::Usage: fetch-merge-base.sh <base-branch>');
    }
  }, FIXTURE_TIMEOUT_MS);
});

describe('apps/web check change detection on a depth-1 checkout', () => {
  it.each([
    ['a pull request that changes apps/web', 'webMerge', 'web=true'],
    ['a pull request that does not', 'docsMerge', 'web=false'],
  ])('reports %s', (_label, mergeSha, expected) => {
    const clone = shallowCheckout(origin, origin.shas[mergeSha]);
    const result = runDetectWebChanges(clone, { EVENT_NAME: 'pull_request', BASE_REF_NAME: 'before-web-push' });
    expect(result.status, result.output).toBe(0);
    expect(result.web).toBe(expected);
  }, FIXTURE_TIMEOUT_MS);

  it.each([
    ['a push that changes apps/web', 'webPush', 'forwardMerge', 'web=true'],
    ['a push that does not', 'forwardMerge', 'prBase', 'web=false'],
  ])('reports %s', (_label, headSha, beforeSha, expected) => {
    const clone = shallowCheckout(origin, origin.shas[headSha]);
    const result = runDetectWebChanges(clone, { EVENT_NAME: 'push', BEFORE_SHA: origin.shas[beforeSha] });
    expect(result.status, result.output).toBe(0);
    expect(result.web).toBe(expected);
  }, FIXTURE_TIMEOUT_MS);

  it('retries a failed fetch before comparing', () => {
    const { forwardMerge, prBase } = origin.shas;
    const clone = shallowCheckout(origin, forwardMerge);
    const result = runDetectWebChanges(
      clone,
      { EVENT_NAME: 'push', BEFORE_SHA: prBase },
      gitStubEnv({ failingFetches: 1 }),
    );
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('(attempt 1 of 3); retrying.');
    expect(result.output).not.toContain('running every web check');
    expect(result.web).toBe('web=false');
  }, FIXTURE_TIMEOUT_MS);

  it('runs every web check when the compared commit cannot be fetched', () => {
    const clone = shallowCheckout(origin, origin.shas.forwardMerge);
    const result = runDetectWebChanges(clone, { EVENT_NAME: 'push', BEFORE_SHA: UNKNOWN_SHA });
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain('(attempt 2 of 3); retrying.');
    expect(result.output).toContain(`::warning::Could not fetch ${UNKNOWN_SHA} after 3 attempts; running every web check.`);
    expect(result.web).toBe('web=true');
  }, FIXTURE_TIMEOUT_MS);

  it('runs every web check when the diff itself fails', () => {
    const { forwardMerge, prBase } = origin.shas;
    const clone = shallowCheckout(origin, forwardMerge);
    const result = runDetectWebChanges(
      clone,
      { EVENT_NAME: 'push', BEFORE_SHA: prBase },
      gitStubEnv({ failSubcommand: 'diff' }),
    );
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(`::warning::Could not diff against ${prBase}; running every web check.`);
    expect(result.web).toBe('web=true');
  }, FIXTURE_TIMEOUT_MS);

  it('runs every web check without fetching when the push has no previous commit', () => {
    const clone = shallowCheckout(origin, origin.shas.forwardMerge);
    const result = runDetectWebChanges(clone, { EVENT_NAME: 'push', BEFORE_SHA: ZERO_SHA });
    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain('::warning::');
    expect(result.web).toBe('web=true');
  }, FIXTURE_TIMEOUT_MS);
});

describe('verification lanes keep bounded checkouts', () => {
  const checkoutOf = (job) => job.steps.find((step) => String(step.uses ?? '').startsWith('actions/checkout@'));

  it.each([
    ['apps-web-check.yml', 'check'],
    ['build-check.yml', 'server-unit-worker'],
    ['build-check.yml', 'server-integration-worker'],
  ])('%s %s fetches only the tested commit', (file, jobId) => {
    expect(checkoutOf(loadWorkflow(file).jobs[jobId]).with?.['fetch-depth']).toBe(1);
  });

  it.each([
    ['changeset-check.yml', 'check'],
    ['check-image-alt-text.yml', 'check-images'],
    ['check-migration-numbers.yml', 'check'],
    ['check-testable-snippets.yml', 'check-snippets'],
  ])('%s %s fetches the merge base before diffing against it', (file, jobId) => {
    const { steps } = loadWorkflow(file).jobs[jobId];
    expect(checkoutOf({ steps }).with?.['fetch-depth'] ?? 1).toBe(1);
    const fetchIndex = steps.findIndex((step) => String(step.run ?? '').includes('scripts/fetch-merge-base.sh'));
    const diffIndex = steps.findIndex((step) => /\.\.\.HEAD|--since=|check-changeset-protocol-scope/.test(String(step.run ?? '')));
    expect(fetchIndex).toBeGreaterThan(-1);
    expect(diffIndex).toBeGreaterThan(fetchIndex);
  });
});
