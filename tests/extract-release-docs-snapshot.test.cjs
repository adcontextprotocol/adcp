const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.join(__dirname, '..');
const extractScript = path.join(repoRoot, 'scripts/extract-release-docs-snapshot.sh');
const workflow = fs.readFileSync(path.join(repoRoot, '.github/workflows/release-docs.yml'), 'utf8');

const PREVIEW_PAGES = [
  'reference/whats-new-in-3-3.mdx',
  'reference/3-3-beta.mdx',
  'reference/migration/3-2-to-3-3.mdx',
];

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// A repository shaped like the release-docs checkout: a release tag whose
// docs/ tree is small, and a later main whose docs/ tree has moved on.
function releaseRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-release-docs-'));
  git(root, 'init', '-q', '-b', 'main');
  write(root, 'docs/intro.mdx', 'tag intro\n');
  write(root, 'docs/media-buy/task.mdx', 'tag task\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'release');
  git(root, 'tag', 'v3.2.9');
  write(root, 'docs/intro.mdx', 'main intro\n');
  write(root, 'docs/reference/trust-json.mdx', 'main only\n');
  write(root, 'docs/runbooks/ops.md', 'main only\n');
  for (const page of PREVIEW_PAGES) write(root, `docs/${page}`, `main preview ${page}\n`);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'main moves on');
  return root;
}

function extract(root, version, ref) {
  return spawnSync('bash', [extractScript, version, ref], { cwd: root, encoding: 'utf8' });
}

function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(dir, full).split(path.sep).join('/'));
    }
  };
  walk(dir);
  return out.sort();
}

test('a stable 3.2 snapshot is the tag plus only the declared 3.3 preview pages', () => {
  const root = releaseRepo();
  const result = extract(root, '3.2.9', 'v3.2.9');
  assert.equal(result.status, 0, result.stderr);

  const snapshot = path.join(root, 'dist/docs/3.2.9');
  assert.deepEqual(
    listFiles(snapshot),
    ['intro.mdx', 'media-buy/task.mdx', ...PREVIEW_PAGES].sort()
  );
  // The tag's bytes win over main's later edit, and main-only pages stay out.
  assert.equal(fs.readFileSync(path.join(snapshot, 'intro.mdx'), 'utf8'), 'tag intro\n');
  assert.equal(fs.existsSync(path.join(snapshot, 'reference/trust-json.mdx')), false);
  assert.equal(fs.existsSync(path.join(snapshot, 'runbooks/ops.md')), false);
  assert.match(result.stdout, /Carried main-only preview page docs\/reference\/3-3-beta\.mdx/);
});

test('the checkout docs/ tree is left in place', () => {
  const root = releaseRepo();
  const before = listFiles(path.join(root, 'docs'));
  const result = extract(root, '3.2.9', 'v3.2.9');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(listFiles(path.join(root, 'docs')), before);
  assert.equal(fs.readFileSync(path.join(root, 'docs/intro.mdx'), 'utf8'), 'main intro\n');
});

test('other release lines carry nothing from the checkout', () => {
  const root = releaseRepo();
  git(root, 'tag', 'v3.1.9', 'v3.2.9');
  const result = extract(root, '3.1.9', 'v3.1.9');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(listFiles(path.join(root, 'dist/docs/3.1.9')), ['intro.mdx', 'media-buy/task.mdx']);
});

test('a preview page already in the tag is not overwritten from the checkout', () => {
  const root = releaseRepo();
  git(root, 'checkout', '-q', 'v3.2.9');
  write(root, 'docs/reference/3-3-beta.mdx', 'tag copy\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'tag ships a preview page');
  git(root, 'tag', 'v3.2.10');
  git(root, 'checkout', '-q', 'main');
  const result = extract(root, '3.2.10', 'v3.2.10');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(path.join(root, 'dist/docs/3.2.10/reference/3-3-beta.mdx'), 'utf8'),
    'tag copy\n'
  );
});

test('refuses to regenerate a snapshot that is already committed, leaving its bytes unchanged', () => {
  const root = releaseRepo();
  const first = extract(root, '3.2.9', 'v3.2.9');
  assert.equal(first.status, 0, first.stderr);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'publish snapshot');
  const snapshot = path.join(root, 'dist/docs/3.2.9');
  const before = Object.fromEntries(
    listFiles(snapshot).map((file) => [file, fs.readFileSync(path.join(snapshot, file), 'utf8')])
  );

  // Even a rerun against a different ref must fail before any mutation.
  for (const ref of ['v3.2.9', 'main']) {
    const rerun = extract(root, '3.2.9', ref);
    assert.notEqual(rerun.status, 0);
    assert.match(rerun.stderr, /already tracked in this checkout/);
  }
  const after = Object.fromEntries(
    listFiles(snapshot).map((file) => [file, fs.readFileSync(path.join(snapshot, file), 'utf8')])
  );
  assert.deepEqual(after, before);
  assert.equal(git(root, 'status', '--porcelain').trim(), '');
});

test('refuses a snapshot that is staged but not yet committed', () => {
  const root = releaseRepo();
  assert.equal(extract(root, '3.2.9', 'v3.2.9').status, 0);
  git(root, 'add', '-A');
  const rerun = extract(root, '3.2.9', 'v3.2.9');
  assert.notEqual(rerun.status, 0);
  assert.match(rerun.stderr, /already tracked in this checkout/);
});

test('re-running replaces a stale snapshot instead of merging into it', () => {
  const root = releaseRepo();
  write(root, 'dist/docs/3.2.9/stale.mdx', 'stale\n');
  const result = extract(root, '3.2.9', 'v3.2.9');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(root, 'dist/docs/3.2.9/stale.mdx')), false);
});

test('fails closed on an unknown ref, an invalid version, or a missing preview page', () => {
  const root = releaseRepo();
  assert.notEqual(extract(root, '3.2.9', 'v9.9.9').status, 0);
  assert.notEqual(extract(root, '3.2', 'v3.2.9').status, 0);

  fs.rmSync(path.join(root, 'docs/reference/3-3-beta.mdx'));
  const missing = extract(root, '3.2.9', 'v3.2.9');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /carried preview page docs\/reference\/3-3-beta\.mdx/);
});

test('the release-docs workflow extracts through the guarded script', () => {
  assert.match(workflow, /bash scripts\/extract-release-docs-snapshot\.sh "\$VERSION" "\$SOURCE_REF"/);
  // The former fallback overlaid the tag onto main's docs/ and moved the
  // merged tree into the snapshot.
  assert.doesNotMatch(workflow, /mv docs\/\* "dist\/docs\/\$VERSION\/"/);
  assert.doesNotMatch(workflow, /git archive "\$SOURCE_REF" -- docs \| tar -x\s*$/m);
});
