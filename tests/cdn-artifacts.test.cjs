const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const VERSIONS = ['3.2.0-rc.0', '3.2.0-rc.1', '3.2.0-rc.2', '3.2.0-rc.3'];
const ROWS = 'test-vectors/reporting-reconciliation/rows.jsonl';
const ROWS_SHA = '735610f303d6d91aa618df3aa6d7f18bcf5dfa52bdbd9ef551293e6bd14c92d9';
const IMMUTABLE = 'public, max-age=31536000, immutable';
const REVALIDATE = 'public, no-cache, must-revalidate';
const TYPES = {
  yaml: 'application/yaml; charset=utf-8',
  yml: 'application/yaml; charset=utf-8',
  json: 'application/json; charset=utf-8',
  jsonl: 'application/x-ndjson; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  mdx: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
// The JSONL fix can land before or after the publication gate. Only the test
// fixture adapts; production must never regain live unscoped bulk publication.
const FENCED_PUBLICATION = fs.existsSync(path.join(ROOT, 'scripts/check-release-state.cjs'));
const REAL_GIT = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

// Execute the real shell publisher with an isolated AWS boundary. Apply AWS's
// ordered include/exclude globs to actual nested files, recording upload bytes
// and metadata. No credentials, bucket, or network are used by these tests.
function awsStub() {
  const fs = require('node:fs');
  const path = require('node:path');
  const args = process.argv.slice(2);
  const [service, operation, source, destination] = args;
  const value = flag => args[args.indexOf(flag) + 1];
  const uploads = [];
  const record = () => fs.appendFileSync(process.env.AWS_TEST_LOG, JSON.stringify({ args, uploads }) + '\n');
  const objects = JSON.parse(fs.readFileSync(process.env.AWS_TEST_OBJECTS, 'utf8'));
  if (service === 's3api') {
    const key = `s3://${value('--bucket')}/${value('--key')}`;
    if (operation === 'head-object') {
      record();
      if (!Object.hasOwn(objects, key)) {
        console.error('An error occurred (404) when calling HeadObject');
        process.exit(1);
      }
    } else if (operation === 'put-object') {
      if (value('--if-none-match') !== '*') throw Error('Unconditional immutable write');
      if (Object.hasOwn(objects, key)) throw Error('PreconditionFailed');
      const upload = { key, body: fs.readFileSync(value('--body')).toString('base64'),
        contentType: value('--content-type'), cacheControl: value('--cache-control') };
      objects[key] = upload;
      fs.writeFileSync(process.env.AWS_TEST_OBJECTS, JSON.stringify(objects));
      uploads.push(upload);
      record();
    } else throw Error(`Unexpected s3api operation: ${operation}`);
    return;
  }
  if (service !== 's3' || !['sync', 'cp'].includes(operation)) throw Error(`Unexpected AWS command: ${args}`);
  if (operation === 'cp' && source.startsWith('s3://')) {
    if (!Object.hasOwn(objects, source)) throw Error(`Missing fixture object: ${source}`);
    fs.writeFileSync(destination, Buffer.from(objects[source].body, 'base64'));
    record();
    return;
  }
  const filters = [];
  for (let i = 4; i < args.length; i++) {
    if (args[i] === '--include' || args[i] === '--exclude') {
      const include = args[i++] === '--include';
      const regex = args[i].split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      filters.push({ include, regex: new RegExp(`^${regex}$`) });
    }
  }
  function upload(file, relative = '') {
    let included = true;
    for (const filter of filters) if (filter.regex.test(relative)) included = filter.include;
    if (included && !args.includes('--dryrun')) uploads.push({
      key: relative ? `${destination}/${relative}` : destination,
      body: fs.readFileSync(file).toString('base64'),
      contentType: value('--content-type'),
      cacheControl: value('--cache-control'),
    });
  }
  function visit(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(file, relative);
      else if (entry.isFile()) upload(file, relative);
    }
  }
  if (operation === 'sync' || args.includes('--recursive')) visit(source);
  else upload(source);
  record();
}

// Fake only remote authority; local tracked-file and tuple comparisons use git.
function gitStub() {
  const args = process.argv.slice(2);
  if (args[0] === 'ls-remote') {
    const ref = args.find(arg => arg.startsWith('refs/heads/') || arg.startsWith('refs/tags/'));
    const allowed = ['refs/heads/main', ...JSON.parse(process.env.TEST_VERSIONS).map(v => `refs/tags/v${v}`)];
    if (!allowed.includes(ref)) throw Error(`Unexpected remote ref: ${ref}`);
    console.log(`${process.env.TESTED_SHA}\t${ref}`);
    return;
  }
  if (!['diff', 'ls-files', 'cat-file'].includes(args[0])) throw Error(`Unexpected git command: ${args}`);
  const result = require('node:child_process').spawnSync(process.env.TEST_REAL_GIT, args, { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

function ghStub() {
  const fs = require('node:fs');
  const path = require('node:path');
  const args = process.argv.slice(2);
  const version = JSON.parse(process.env.TEST_VERSIONS).find(v => `v${v}` === args[2]);
  if (args[0] !== 'release' || !version) throw Error(`Unexpected gh command: ${args}`);
  const names = ['tgz', 'tgz.sha256', 'tgz.sig', 'tgz.crt'].map(suffix => `${version}.${suffix}`);
  if (args[1] === 'view') {
    console.log(JSON.stringify({ tagName: `v${version}`, isDraft: false, isPrerelease: true,
      assets: names.map(name => ({ name })) }));
  } else if (args[1] === 'download') {
    const name = names.find(name => name === args[args.indexOf('--pattern') + 1]);
    if (!name) throw Error('Unexpected release asset');
    fs.copyFileSync(path.join('dist/protocol', name), path.join(args[args.indexOf('--dir') + 1], name));
  } else throw Error(`Unexpected release operation: ${args[1]}`);
  fs.appendFileSync(process.env.GH_TEST_LOG, JSON.stringify(args) + '\n');
}

function fixture(t, publication = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-cdn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, bytes) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), bytes);
  };
  write('scripts/verify-cdn-artifacts-cutover.mjs', fs.readFileSync(path.join(ROOT, 'scripts/verify-cdn-artifacts-cutover.mjs')));
  const executable = (name, stub) => {
    write(`bin/${name}`, `#!${process.execPath}\n(${stub.toString()})();\n`);
    fs.chmodSync(path.join(dir, 'bin', name), 0o755);
  };
  executable('aws', awsStub);
  write('objects.json', '{}');
  write('gh.jsonl', '');
  for (const version of [...VERSIONS, 'latest']) {
    const sourceVersion = version === 'latest' ? VERSIONS.at(-1) : version;
    // Reuse the immutable regression fixtures, without a second checked-in copy.
    write(`dist/compliance/${version}/${ROWS}`, fs.readFileSync(path.join(ROOT, `dist/compliance/${sourceVersion}/${ROWS}`)));
    write(`dist/compliance/${version}/index.json`, JSON.stringify({ version }));
    write(`dist/schemas/${version}/index.json`, '{}');
    for (const suffix of ['tgz', 'tgz.sha256', 'tgz.sig', 'tgz.crt']) write(`dist/protocol/${version}.${suffix}`, 'fixture');
    for (const ext of Object.keys(TYPES).filter(ext => ext !== 'jsonl')) {
      write(`dist/compliance/${version}/nested directory/file.${ext}`, 'fixture\n');
    }
  }
  write('dist/compliance/storyboard-runner-options.js', 'excluded runtime file');
  write('dist/schemas/index.json', '{}');
  write('dist/schemas/latest.json', '{}');
  if (FENCED_PUBLICATION) {
    write('package.json', JSON.stringify({ version: VERSIONS.at(-1) }));
    const git = args => execFileSync(REAL_GIT, args, { cwd: dir, encoding: 'utf8' }).trim();
    git(['init', '-q']);
    git(['add', 'dist', 'package.json']);
    git(['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'core.hooksPath=/dev/null',
      'commit', '-qm', 'Approved fixture release']);
    write('tested-sha', git(['rev-parse', 'HEAD']));
    executable('git', gitStub);
    executable('gh', ghStub);
    // A version-scoped publisher must use tracked assets, not every local file.
    if (publication) for (const version of VERSIONS) write(`dist/compliance/${version}/untracked.jsonl`, 'untracked');
  }
  return { dir, write };
}

function publish(dir, flags = []) {
  const log = path.join(dir, 'aws.jsonl');
  fs.writeFileSync(log, '');
  const testedSha = FENCED_PUBLICATION ? fs.readFileSync(path.join(dir, 'tested-sha'), 'utf8') : undefined;
  const authority = FENCED_PUBLICATION ? {
    TESTED_SHA: testedSha, RELEASE_SHA: testedSha,
    PUBLICATION_BRANCH: 'main', TEST_VERSIONS: JSON.stringify(VERSIONS), TEST_REAL_GIT: REAL_GIT,
    GH_TEST_LOG: path.join(dir, 'gh.jsonl'), RUNNER_TEMP: dir,
  } : {};
  const stdout = execFileSync('bash', [path.join(ROOT, 'scripts/backfill-cdn-artifacts.sh'),
    '--bucket', 'test-bucket', '--endpoint', 'https://r2.invalid', ...flags], {
    cwd: dir,
    env: { PATH: `${dir}/bin:${process.env.PATH}`, AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test',
      AWS_TEST_LOG: log, AWS_TEST_OBJECTS: path.join(dir, 'objects.json'), ...authority },
    encoding: 'utf8',
  });
  const calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(JSON.parse);
  return { stdout, calls, uploads: calls.flatMap(call => call.uploads) };
}

for (const skipLatest of [false, true]) {
  test(`publishes every compliance extension with exact bytes and cache policy (skip latest: ${skipLatest})`, t => {
    const { dir } = fixture(t, true);
    const results = FENCED_PUBLICATION
      ? [...VERSIONS.map(version => publish(dir, ['--version', version, '--skip-latest'])),
        ...(skipLatest ? [] : [publish(dir, ['--latest-only'])])]
      : [publish(dir, skipLatest ? ['--skip-latest'] : [])];
    const calls = results.flatMap(result => result.calls);
    const uploads = results.flatMap(result => result.uploads);
    if (FENCED_PUBLICATION) {
      for (const [i, result] of results.entries()) {
        const prefix = i < VERSIONS.length ? VERSIONS[i] : 'latest';
        assert.ok(result.uploads.length > 0);
        assert.ok(result.uploads.every(upload => upload.key.includes(`/${prefix}/`) || upload.key.includes(`/${prefix}.`)));
      }
      const ghCalls = fs.readFileSync(path.join(dir, 'gh.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
      for (const version of VERSIONS) {
        assert.equal(ghCalls.filter(args => args[1] === 'view' && args[2] === `v${version}`).length, 1);
        assert.equal(ghCalls.filter(args => args[1] === 'download' && args[2] === `v${version}`).length, 4);
      }
    }
    const compliance = uploads.filter(upload => upload.key.includes('/compliance/'));
    for (const version of VERSIONS) {
      const row = compliance.filter(upload => upload.key === `s3://test-bucket/compliance/${version}/${ROWS}`);
      assert.equal(row.length, 1, version);
      assert.equal(sha256(Buffer.from(row[0].body, 'base64')), ROWS_SHA);
    }
    assert.equal(compliance.length, (skipLatest ? 4 : 5) * 8);
    for (const upload of compliance) {
      const key = upload.key.replace('s3://test-bucket/', '');
      assert.equal(upload.contentType, TYPES[path.extname(key).slice(1)], key);
      assert.equal(upload.cacheControl, key.startsWith('compliance/latest/') ? REVALIDATE : IMMUTABLE, key);
      assert.deepEqual(Buffer.from(upload.body, 'base64'), fs.readFileSync(path.join(dir, 'dist', key)), key);
    }
    for (const call of calls) {
      assert.ok(!call.args.includes('--delete'));
      if (call.args[1] === 'sync') assert.ok(call.args.includes('--size-only'));
      if (call.args.includes('--recursive')) assert.ok(!call.args.includes('--size-only'));
      if (call.args[0] === 's3' && call.uploads.length) assert.ok(call.args.includes('--no-guess-mime-type'));
      if (call.args[1] === 'put-object') assert.equal(call.args[call.args.indexOf('--if-none-match') + 1], '*');
    }
    // Existing schema pointers and protocol tuple semantics must stay intact.
    for (const upload of uploads.filter(upload => !upload.key.includes('/compliance/'))) {
      const key = upload.key.replace('s3://test-bucket/', '');
      const immutable = VERSIONS.some(version => key.startsWith(`schemas/${version}/`)
        || (FENCED_PUBLICATION ? key.startsWith(`protocol/${version}.`) : key === `protocol/${version}.tgz`));
      assert.equal(upload.cacheControl, immutable ? IMMUTABLE : REVALIDATE, key);
    }
    assert.equal(uploads.some(upload => upload.key.includes('/latest')), !skipLatest);
    assert.equal(uploads.some(upload => upload.key.endsWith('/schemas/index.json')), !FENCED_PUBLICATION && !skipLatest);
    if (!skipLatest) {
      assert.equal(uploads.filter(upload => upload.key === `s3://test-bucket/compliance/latest/${ROWS}`).length, 1);
    }
  });
}

for (const version of VERSIONS) {
  test(`fenced ${version} recovery creates only the missing JSONL and preserves existing bytes`, { skip: !FENCED_PUBLICATION }, t => {
    const { dir } = fixture(t, true);
    const flags = ['--version', version, '--skip-latest'];
    publish(dir, flags);
    const objectsFile = path.join(dir, 'objects.json');
    const complete = JSON.parse(fs.readFileSync(objectsFile, 'utf8'));
    const key = `s3://test-bucket/compliance/${version}/${ROWS}`;
    const missing = { ...complete };
    delete missing[key];
    fs.writeFileSync(objectsFile, JSON.stringify(missing));
    const recovered = publish(dir, flags);
    assert.deepEqual(recovered.uploads, [complete[key]]);
    assert.equal(sha256(Buffer.from(recovered.uploads[0].body, 'base64')), ROWS_SHA);
    assert.deepEqual(JSON.parse(fs.readFileSync(objectsFile, 'utf8')), complete);
    const repeated = publish(dir, flags);
    assert.equal(repeated.uploads.length, 0);
    assert.ok(repeated.calls.some(call => call.args[2]?.endsWith(ROWS)));
    complete[key].body = Buffer.from('existing divergent bytes').toString('base64');
    fs.writeFileSync(objectsFile, JSON.stringify(complete));
    assert.throws(() => publish(dir, flags), /Immutable object differs/);
    assert.deepEqual(JSON.parse(fs.readFileSync(objectsFile, 'utf8')), complete);
  });
}

test('both dry-run modes enumerate JSONL without uploading', t => {
  for (const flag of ['--dry-run', '--aws-dry-run']) {
    const { dir } = fixture(t);
    const result = publish(dir, [flag]);
    assert.match(result.stdout, /x-ndjson/);
    assert.match(result.stdout, /jsonl/);
    assert.equal(result.uploads.length, 0);
    assert.equal(result.calls.length > 0, flag === '--aws-dry-run');
  }
});

test('all committed semver compliance extensions are supported, including every historical JSONL', () => {
  const files = execFileSync('git', ['ls-files', 'dist/compliance'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
    .trim().split('\n').filter(file => /^dist\/compliance\/\d+\.\d+\.\d+(?:-[\w.-]+)?\//.test(file));
  assert.ok(files.length > 0);
  for (const file of files) assert.ok(Object.hasOwn(TYPES, path.extname(file).slice(1)), `Unsupported compliance artifact: ${file}`);
  for (const version of VERSIONS) {
    const file = `dist/compliance/${version}/${ROWS}`;
    assert.ok(files.includes(file));
    assert.equal(sha256(fs.readFileSync(path.join(ROOT, file))), ROWS_SHA);
    const bundled = execFileSync('tar', ['-xOf', `dist/protocol/${version}.tgz`, `adcp-${version}/compliance/${ROWS}`], { cwd: ROOT });
    assert.equal(sha256(bundled), ROWS_SHA, `${version} bundle preserves the same fixture`);
  }
});

async function verify(t, dir, versions, change = () => {}) {
  const requested = [];
  // Build responses from trusted fixture paths before accepting requests.
  // A request only selects a map entry; it never becomes a filesystem path.
  const responses = new Map();
  function preload(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const url = `${prefix}/${encodeURIComponent(entry.name)}`;
      if (entry.isDirectory()) preload(file, url);
      else if (entry.isFile()) responses.set(url, fs.readFileSync(file));
    }
  }
  preload(path.join(dir, 'dist'));
  const server = http.createServer((req, res) => {
    requested.push(req.url);
    let body = responses.get(req.url) ?? Buffer.from('{}');
    res.setHeader('content-type', TYPES[path.extname(req.url).slice(1)] ?? 'application/json');
    res.setHeader('cache-control', IMMUTABLE);
    const replacement = change(req, res, body);
    if (replacement !== undefined) body = replacement;
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  const args = [path.join(dir, 'scripts/verify-cdn-artifacts-cutover.mjs'), '--candidate', url,
    '--reference', versions ? 'http://127.0.0.1:1' : url,
    ...(versions ?? []).flatMap(version => ['--compliance-version', version])];
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: dir });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, output }));
  });
  return { ...result, requested };
}

test('default cutover verification enumerates all nested compliance files without an extension allowlist', async t => {
  const { dir, write } = fixture(t);
  write('dist/compliance/3.2.0-rc.3/nested directory/future.csv', 'future extension');
  const result = await verify(t, dir);
  assert.equal(result.code, 0, result.output);
  for (const version of VERSIONS) assert.ok(result.requested.includes(`/compliance/${version}/${ROWS}`));
  assert.ok(result.requested.includes('/compliance/3.2.0-rc.3/nested%20directory/future.csv'));
  assert.ok(!result.requested.includes('/compliance/storyboard-runner-options.js'));
});

test('scoped verification checks all four omissions against local bytes without remote discovery', async t => {
  const { dir } = fixture(t);
  const result = await verify(t, dir, VERSIONS);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.requested.length, 32);
  for (const version of VERSIONS) assert.ok(result.requested.includes(`/compliance/${version}/${ROWS}`));
});

for (const defect of ['missing', 'redirect', 'bytes', 'content-type', 'cache-control']) {
  test(`verification fails on JSONL ${defect}`, async t => {
    const { dir } = fixture(t);
    const result = await verify(t, dir, VERSIONS, (req, res, body) => {
      if (!req.url.endsWith('.jsonl')) return;
      if (defect === 'missing') { res.statusCode = 404; return 'Not Found'; }
      if (defect === 'redirect') { res.statusCode = 302; res.setHeader('location', '/compliance/latest/' + ROWS); }
      if (defect === 'bytes') return Buffer.concat([body, Buffer.from('\n')]);
      if (defect === 'content-type') res.setHeader('content-type', 'application/json');
      if (defect === 'cache-control') res.setHeader('cache-control', REVALIDATE);
    });
    assert.equal(result.code, 1, result.output);
    for (const version of VERSIONS) assert.ok(result.output.includes(`/compliance/${version}/${ROWS}`), result.output);
  });
}

test('matching remote errors cannot pass cutover verification', async t => {
  const { dir } = fixture(t);
  const result = await verify(t, dir, undefined, (req, res) => {
    if (req.url === '/protocol/latest.tgz') { res.statusCode = 404; return 'Not Found'; }
  });
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /expected successful content, got 404/);
});

test('scoped verification refuses missing local versions and path traversal', async t => {
  const { dir } = fixture(t);
  for (const version of ['3.2.0-rc.99', '../3.2.0-rc.3']) {
    const result = await verify(t, dir, [version]);
    assert.equal(result.code, 1, result.output);
    assert.equal(result.requested.length, 0);
  }
});
