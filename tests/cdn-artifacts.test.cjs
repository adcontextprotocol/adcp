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

// Execute the real shell publisher with an isolated AWS boundary. Apply AWS's
// ordered include/exclude globs to actual nested files, recording upload bytes
// and metadata. No credentials, bucket, or network are used by these tests.
function awsStub() {
  const fs = require('node:fs');
  const path = require('node:path');
  const args = process.argv.slice(2);
  const [service, operation, source, destination] = args;
  if (service !== 's3' || !['sync', 'cp'].includes(operation)) process.exit(2);
  const value = flag => args[args.indexOf(flag) + 1];
  const filters = [];
  for (let i = 4; i < args.length; i++) {
    if (args[i] === '--include' || args[i] === '--exclude') {
      const include = args[i++] === '--include';
      const regex = args[i].split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
      filters.push({ include, regex: new RegExp(`^${regex}$`) });
    }
  }
  const uploads = [];
  function visit(file, relative = '') {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file)) visit(path.join(file, name), relative ? `${relative}/${name}` : name);
    } else {
      let included = true;
      for (const filter of filters) if (filter.regex.test(relative)) included = filter.include;
      if (included && !args.includes('--dryrun')) uploads.push({
        key: relative ? `${destination}/${relative}` : destination,
        body: fs.readFileSync(file).toString('base64'),
        contentType: value('--content-type'),
        cacheControl: value('--cache-control'),
      });
    }
  }
  visit(source);
  fs.appendFileSync(process.env.AWS_TEST_LOG, JSON.stringify({ args, uploads }) + '\n');
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-cdn-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (name, bytes) => {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), bytes);
  };
  write('scripts/verify-cdn-artifacts-cutover.mjs', fs.readFileSync(path.join(ROOT, 'scripts/verify-cdn-artifacts-cutover.mjs')));
  write('bin/aws', `#!${process.execPath}\n(${awsStub.toString()})();\n`);
  fs.chmodSync(path.join(dir, 'bin/aws'), 0o755);
  for (const version of [...VERSIONS, 'latest']) {
    const sourceVersion = version === 'latest' ? VERSIONS.at(-1) : version;
    // Reuse the immutable regression fixtures, without a second checked-in copy.
    write(`dist/compliance/${version}/${ROWS}`, fs.readFileSync(path.join(ROOT, `dist/compliance/${sourceVersion}/${ROWS}`)));
    write(`dist/compliance/${version}/index.json`, JSON.stringify({ version }));
    for (const ext of Object.keys(TYPES).filter(ext => ext !== 'jsonl')) {
      write(`dist/compliance/${version}/nested directory/file.${ext}`, 'fixture\n');
    }
  }
  write('dist/compliance/storyboard-runner-options.js', 'excluded runtime file');
  write('dist/schemas/3.2.0-rc.3/index.json', '{}');
  write('dist/schemas/latest/index.json', '{}');
  write('dist/schemas/index.json', '{}');
  write('dist/schemas/latest.json', '{}');
  for (const version of ['3.2.0-rc.3', 'latest']) {
    for (const suffix of ['tgz', 'tgz.sha256', 'tgz.sig', 'tgz.crt']) write(`dist/protocol/${version}.${suffix}`, 'fixture');
  }
  return { dir, write };
}

function publish(dir, flags = []) {
  const log = path.join(dir, 'aws.jsonl');
  const stdout = execFileSync('bash', [path.join(ROOT, 'scripts/backfill-cdn-artifacts.sh'),
    '--bucket', 'test-bucket', '--endpoint', 'https://r2.invalid', ...flags], {
    cwd: dir,
    env: { PATH: `${dir}/bin:${process.env.PATH}`, AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', AWS_TEST_LOG: log },
    encoding: 'utf8',
  });
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  return { stdout, calls, uploads: calls.flatMap(call => call.uploads) };
}

for (const skipLatest of [false, true]) {
  test(`publishes every compliance extension with exact bytes and cache policy (skip latest: ${skipLatest})`, t => {
    const { dir } = fixture(t);
    const { calls, uploads } = publish(dir, skipLatest ? ['--skip-latest'] : []);
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
      assert.ok(call.args.includes('--no-guess-mime-type'));
    }
    // Existing schema pointers and protocol tuple semantics must stay intact.
    for (const upload of uploads.filter(upload => !upload.key.includes('/compliance/'))) {
      const key = upload.key.replace('s3://test-bucket/', '');
      const immutable = key === 'schemas/3.2.0-rc.3/index.json' || key === 'protocol/3.2.0-rc.3.tgz';
      assert.equal(upload.cacheControl, immutable ? IMMUTABLE : REVALIDATE, key);
    }
    assert.equal(uploads.some(upload => upload.key.includes('/latest')), !skipLatest);
    assert.equal(uploads.some(upload => upload.key.endsWith('/schemas/index.json')), !skipLatest);
    if (!skipLatest) {
      assert.equal(uploads.filter(upload => upload.key === `s3://test-bucket/compliance/latest/${ROWS}`).length, 1);
    }
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
  const server = http.createServer((req, res) => {
    requested.push(req.url);
    const local = path.join(dir, 'dist', decodeURIComponent(req.url));
    let body = fs.existsSync(local) && fs.statSync(local).isFile() ? fs.readFileSync(local) : Buffer.from('{}');
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
