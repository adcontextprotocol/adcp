const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const test = require('node:test');

const script = path.join(__dirname, 'npm-ci.mjs');
// Verbatim npm stderr from main job 104032687845 (2026-09-14), with the
// checkout path replaced per fixture. No network, installed dependencies or Rust.
const signature = `npm error code 1
npm error path ROOT/node_modules/@contentauth/c2pa-node
npm error command failed
npm error command sh -c node scripts/postinstall.cjs
npm error Detected { arch: 'x64', platform: 'linux' }
npm error Checking for a release at: https://github.com/contentauth/c2pa-js/releases/download/%40contentauth%2Fc2pa-node%400.9.4/c2pa-node_x86_64-unknown-linux-gnu-v0.9.4.zip
npm error 🦀 Building Rust...
npm error ERROR: Error: Command failed: npx cargo-cp-artifact -nc "ROOT/node_modules/@contentauth/c2pa-node/dist/index.node" -- cargo build --message-format=json-render-diagnostics --release --manifest-path="ROOT/node_modules/@contentauth/c2pa-node/Cargo.toml"
npm error error: failed to parse manifest at \`ROOT/node_modules/@contentauth/c2pa-node/Cargo.toml\`
npm error
npm error Caused by:
npm error   error inheriting \`rust-version\` from workspace root manifest's \`workspace.package.rust-version\`
npm error
npm error Caused by:
npm error   failed to find a workspace root
npm error Did not copy "cdylib:c2pa-node"
`;

const fakeNpm = `
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const plan = JSON.parse(fs.readFileSync('plan.json'));
const count = fs.existsSync('calls.json') ? JSON.parse(fs.readFileSync('calls.json')) : [];
count.push({ args: process.argv.slice(2), pid: process.pid });
fs.writeFileSync('calls.json', JSON.stringify(count));
const step = plan[count.length - 1];
if (!step) process.exit(99);
fs.writeFileSync(1, (step.out || '').replaceAll('ROOT', process.cwd()));
fs.writeFileSync(2, (step.err || '').replaceAll('ROOT', process.cwd()));
if (step.signal) process.kill(process.pid, step.signal);
else if (step.family) {
  const grandchild = spawn(process.execPath, ['-e', \`
    const fs = require('node:fs');
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
      fs.writeFileSync('grandchild-signal', signal);
      process.exit(0);
    });
    setInterval(() => {}, 1000);
    process.send('ready');
  \`], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => {
    fs.writeFileSync('npm-signal', signal);
    process.exit(0);
  });
  grandchild.on('message', () => fs.writeFileSync(1, 'ready\\n'));
} else if (step.wait) {
  fs.writeFileSync(1, 'ready\\n');
  const timer = setInterval(() => {
    if (fs.existsSync('continue')) { clearInterval(timer); process.exit(step.code || 0); }
  }, 10);
} else process.exit(step.code || 0);
`;

function fixture(t, plan, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-ci-test-'));
  // Shell metacharacters are data in cwd and RUNNER_TEMP, never evaluated.
  const cwd = path.join(dir, 'space $(touch INJECTED) `touch INJECTED`');
  fs.mkdirSync(cwd);
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'npm'), `#!${process.execPath}\n${fakeNpm}`, { mode: 0o700 });
  fs.writeFileSync(path.join(cwd, 'plan.json'), JSON.stringify(plan));
  const child = spawn(process.execPath, [script], {
    cwd,
    env: { PATH: bin, RUNNER_TEMP: cwd, SENTINEL_SECRET: 'never-print-this-secret', ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = once(child, 'close').then(([code, signal]) => ({ code, signal }));
  const calls = () => JSON.parse(fs.readFileSync(path.join(cwd, 'calls.json')));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      for (const call of fs.existsSync(path.join(cwd, 'calls.json')) ? calls() : []) {
        try { process.kill(-call.pid, 'SIGKILL'); } catch {}
      }
      child.kill('SIGKILL');
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    child, cwd, done, calls,
    stdout: () => stdout,
    stderr: () => stderr,
    logs: () => path.join(cwd, fs.readdirSync(cwd).find(name => name.startsWith('adcp-npm-ci-'))),
    async ready() {
      while (!stdout.includes('ready\n')) await once(child.stdout, 'data');
      assert.equal(child.exitCode, null, 'output must arrive while npm is still running');
    },
  };
}

function checkCalls(f, count) {
  assert.equal(f.calls().length, count);
  for (const call of f.calls()) assert.deepEqual(call.args, ['ci']);
  assert.equal((f.stderr().match(/retrying normal npm ci once/g) || []).length, count - 1);
  assert.ok(!f.stderr().includes('never-print-this-secret'));
  assert.ok(!f.stdout().includes('never-print-this-secret'));
  assert.ok(!fs.existsSync(path.join(f.cwd, 'INJECTED')));
}

test('first success: live stdout/stderr and exact normal npm arguments', { timeout: 10000 }, async t => {
  const f = fixture(t, [{ out: 'stdout\n', err: 'stderr\n', wait: true }]);
  await f.ready();
  assert.ok(f.stdout().includes('stdout\n'));
  // Stderr uses its own pipe, so wait for its independent arrival.
  while (!f.stderr().includes('stderr\n')) await once(f.child.stderr, 'data');
  fs.writeFileSync(path.join(f.cwd, 'continue'), '');
  assert.deepEqual(await f.done, { code: 0, signal: null });
  checkCalls(f, 1);
});

test('exact signature then success: one retry, both complete logs retained privately', { timeout: 10000 }, async t => {
  const large = 'x'.repeat(2 * 1024 * 1024) + '\n';
  const f = fixture(t, [
    { code: 1, out: large, err: large + signature },
    { out: 'installed\n', err: 'second attempt\n' },
  ]);
  assert.deepEqual(await f.done, { code: 0, signal: null });
  checkCalls(f, 2);
  const logs = f.logs();
  assert.deepEqual(fs.readdirSync(logs).sort(), [
    'attempt-1.stderr.log', 'attempt-1.stdout.log', 'attempt-2.stderr.log', 'attempt-2.stdout.log',
  ]);
  assert.equal(fs.statSync(logs).mode & 0o777, 0o700);
  for (const file of fs.readdirSync(logs)) assert.equal(fs.statSync(path.join(logs, file)).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(path.join(logs, 'attempt-1.stdout.log'), 'utf8'), large);
  assert.equal(fs.readFileSync(path.join(logs, 'attempt-1.stderr.log'), 'utf8'), large + signature.replaceAll('ROOT', f.cwd));
  assert.equal(fs.readFileSync(path.join(logs, 'attempt-2.stdout.log'), 'utf8'), 'installed\n');
  assert.equal(fs.readFileSync(path.join(logs, 'attempt-2.stderr.log'), 'utf8'), 'second attempt\n');
  assert.equal(f.stdout(), large + 'installed\n');
  assert.ok(f.stderr().includes(signature.replaceAll('ROOT', f.cwd)));
});

test('exact signature twice: fail after exactly two npm ci invocations', { timeout: 10000 }, async t => {
  const f = fixture(t, [{ code: 1, err: signature }, { code: 1, err: signature }, { code: 0 }]);
  assert.deepEqual(await f.done, { code: 1, signal: null });
  checkCalls(f, 2);
  assert.equal(fs.readFileSync(path.join(f.logs(), 'attempt-2.stderr.log'), 'utf8'), signature.replaceAll('ROOT', f.cwd));
});

for (const [name, err] of [
  ['download symptom without workspace fallback', signature.split('npm error 🦀')[0]],
  ['workspace fallback without C2PA/download', 'npm error code 1\nnpm error   failed to find a workspace root\n'],
  ['C2PA workspace fallback without download', signature.split('\n').filter(line => !line.includes('Checking for a release')).join('\n')],
  ['different package', signature.replaceAll('@contentauth/c2pa-node', '@example/other')],
  ['different C2PA version', signature.replaceAll('0.9.4', '0.9.5')],
  ['successful download then unrelated build error', signature.replace('npm error 🦀', 'npm error Downloaded to ROOT/index.node\nnpm error 🦀')],
  ['additional npm integrity failure', signature + 'npm error code EINTEGRITY\n'],
  ['additional failing package', signature + 'npm error path ROOT/node_modules/other\n'],
  ['arbitrary npm failure', 'npm error code EUSAGE\nnpm error package-lock.json is out of sync\n'],
]) {
  test(`${name}: no retry`, { timeout: 10000 }, async t => {
    const f = fixture(t, [{ code: 1, err }, { code: 0 }]);
    assert.deepEqual(await f.done, { code: 1, signal: null });
    checkCalls(f, 1);
    assert.equal(fs.readFileSync(path.join(f.logs(), 'attempt-1.stderr.log'), 'utf8'), err.replaceAll('ROOT', f.cwd));
  });
}

test('matching text on stdout cannot classify a different npm stderr failure', { timeout: 10000 }, async t => {
  const f = fixture(t, [{ code: 1, out: signature, err: 'npm error code EINTEGRITY\n' }]);
  assert.deepEqual(await f.done, { code: 1, signal: null });
  checkCalls(f, 1);
});

for (const code of [2, 42, 127, 130, 143]) {
  test(`preserve exit ${code} even with matching text`, { timeout: 10000 }, async t => {
    const f = fixture(t, [{ code, err: signature }]);
    assert.deepEqual(await f.done, { code, signal: null });
    checkCalls(f, 1);
  });
}

test('preserve arbitrary second-attempt exit', { timeout: 10000 }, async t => {
  const f = fixture(t, [{ code: 1, err: signature }, { code: 42, err: 'npm error code EOTHER\n' }]);
  assert.deepEqual(await f.done, { code: 42, signal: null });
  checkCalls(f, 2);
});

test('missing npm propagates command-not-found without retry', { timeout: 10000 }, async t => {
  const f = fixture(t, [], { env: { PATH: '/does-not-exist' } });
  assert.deepEqual(await f.done, { code: 127, signal: null });
  assert.ok(!fs.existsSync(path.join(f.cwd, 'calls.json')));
  assert.ok(!f.stderr().includes('retrying'));
});

test('second-attempt signal propagates without a third attempt', { timeout: 10000 }, async t => {
  const f = fixture(t, [{ code: 1, err: signature }, { signal: 'SIGTERM', err: signature }]);
  assert.deepEqual(await f.done, { code: null, signal: 'SIGTERM' });
  checkCalls(f, 2);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  test(`npm terminated by ${signal}: same signal, no retry`, { timeout: 10000 }, async t => {
    const f = fixture(t, [{ signal, err: signature }]);
    assert.deepEqual(await f.done, { code: null, signal });
    checkCalls(f, 1);
  });
  test(`forward ${signal} to npm and descendants; don't retry even if npm handles it with exit 0`, { timeout: 10000 }, async t => {
    const f = fixture(t, [{ family: true, err: signature }]);
    await f.ready();
    f.child.kill(signal);
    assert.deepEqual(await f.done, { code: null, signal });
    checkCalls(f, 1);
    for (const file of ['npm-signal', 'grandchild-signal']) assert.equal(fs.readFileSync(path.join(f.cwd, file), 'utf8'), signal);
  });
}
