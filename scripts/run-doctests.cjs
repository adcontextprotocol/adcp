#!/usr/bin/env node
/**
 * Deterministic unit-doctest lane.
 *
 * The existing snippet lane (tests/snippet-validation.test.cjs) routes marked
 * blocks to a LIVE agent — the right tool for wire examples, the wrong tool for
 * pure-logic normative snippets (verifier functions, canonicalization, constant
 * lists) where the failure the audit found (a verifier testing a field that does
 * not exist) is offline and deterministic.
 *
 * This lane introduces a distinct marker: a fenced block tagged `doctest` is a
 * SELF-CONTAINED, OFFLINE program that MUST run to exit 0. It asserts its own
 * invariant and throws on violation. No network, no auth token, no live agent.
 *
 *   ```javascript doctest
 *   function keyPurposeOk(jwk) { return jwk.adcp_use === 'request-signing'; }
 *   if (!keyPurposeOk({ adcp_use: 'request-signing' })) throw new Error('...');
 *   console.log('ok');
 *   ```
 *
 * Fails CI (exit 1) if any doctest block exits non-zero. This is the lane that
 * would have caught the `example_use` reference-verifier bug the moment the page
 * was scanned. See specs/spec-anti-drift.md.
 *
 * Usage:
 *   node scripts/run-doctests.cjs            # scan docs/ + specs/
 *   node scripts/run-doctests.cjs --list     # list doctest blocks, do not run
 *   node scripts/run-doctests.cjs --json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['docs', 'specs'];
const args = process.argv.slice(2);
const listOnly = args.includes('--list');
const asJson = args.includes('--json');
const TIMEOUT_MS = 15000;

// language -> how to run a temp file. Return null to skip (interpreter absent
// or language not permitted). `bash`/`sh` are intentionally NOT runnable: a
// doctest is an offline logic assertion, a shell block is the easiest arbitrary-
// command vector, and this lane runs PR-authored code in CI.
function runner(lang) {
  const l = lang.toLowerCase();
  if (l === 'javascript' || l === 'js') return { ext: '.mjs', cmd: (f) => ['node', [f]] };
  if (l === 'typescript' || l === 'ts') return { ext: '.ts', cmd: (f) => ['npx', ['--no-install', 'tsx', f]] };
  if (l === 'python' || l === 'py') return { ext: '.py', cmd: (f) => ['python3', [f]] };
  return null;
}

function walk(dir, out) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(md|mdx)$/.test(entry.name)) out.push(full);
  }
}

function extractDoctests(file) {
  const content = fs.readFileSync(file, 'utf8');
  const re = /```(\w+)([^\n]*)\n([\s\S]*?)```/g;
  const blocks = [];
  let m;
  while ((m = re.exec(content)) !== null) {
    const [, language, metadata, code] = m;
    if (!/\bdoctest\b/.test(metadata)) continue;
    blocks.push({
      file: path.relative(ROOT, file),
      language,
      code,
      line: content.slice(0, m.index).split('\n').length,
    });
  }
  return blocks;
}

const files = [];
for (const d of SCAN_DIRS) walk(path.join(ROOT, d), files);

const doctests = [];
for (const f of files) doctests.push(...extractDoctests(f));

if (listOnly) {
  for (const d of doctests) console.log(`${d.file}:${d.line} (${d.language})`);
  console.log(`\n${doctests.length} doctest block(s)`);
  process.exit(0);
}

const results = [];
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'adcp-doctest-'));

// Scrubbed environment: a doctest is offline logic, so it never needs inherited
// secrets. Passing only PATH/HOME means that even if this CI job is later given
// secrets, an executed block cannot read them. See normative-guarantees.yml.
const CHILD_ENV = { PATH: process.env.PATH, HOME: process.env.HOME };

try {
  for (const d of doctests) {
    const where = `${d.file}:${d.line}`;
    const r = runner(d.language);
    if (!r) {
      results.push({ where, status: 'skip', reason: `no runner for ${d.language}` });
      continue;
    }
    const tmp = path.join(tmpBase, `dt-${results.length}${r.ext}`);
    fs.writeFileSync(tmp, d.code);
    const [cmd, cmdArgs] = r.cmd(tmp);
    const proc = spawnSync(cmd, cmdArgs, { encoding: 'utf8', timeout: TIMEOUT_MS, env: CHILD_ENV });
    if (proc.error && proc.error.code === 'ENOENT') {
      results.push({ where, status: 'skip', reason: `interpreter '${cmd}' not found` });
      continue;
    }
    if (proc.status === 0) {
      results.push({ where, status: 'pass' });
    } else {
      const timedOut = proc.signal === 'SIGTERM' || (proc.error && proc.error.code === 'ETIMEDOUT');
      results.push({
        where,
        status: 'fail',
        code: timedOut ? `timeout after ${TIMEOUT_MS}ms` : proc.status,
        stderr: (proc.stderr || '').trim().split('\n').slice(-6).join('\n'),
      });
    }
  }
} finally {
  fs.rmSync(tmpBase, { recursive: true, force: true });
}

const pass = results.filter((r) => r.status === 'pass').length;
const fail = results.filter((r) => r.status === 'fail');
const skip = results.filter((r) => r.status === 'skip').length;

if (asJson) {
  console.log(JSON.stringify({ total: results.length, pass, fail: fail.length, skip, failures: fail }, null, 2));
} else {
  console.log(`\nDoctest lane: ${pass} passed, ${fail.length} failed, ${skip} skipped (of ${results.length})`);
  for (const f of fail) {
    console.error(`\n✗ ${f.where} exited ${f.code}`);
    if (f.stderr) console.error(f.stderr.split('\n').map((l) => `    ${l}`).join('\n'));
  }
  if (skip > 0) {
    for (const s of results.filter((r) => r.status === 'skip')) {
      console.log(`  ⊘ ${s.where} — ${s.reason}`);
    }
  }
}

if (fail.length > 0) {
  console.error(`\n✗ doctest lane failed (${fail.length} block(s))`);
  process.exit(1);
}
if (!asJson) console.log('\n✓ all doctest blocks passed');
