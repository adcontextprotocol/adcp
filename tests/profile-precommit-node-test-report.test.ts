// A `node --test --test-force-exit` run must report every test that ran, so
// that the results the profiler collects (node-test.json) and the junit files
// the goal's coverage check reads count every test.
//
// tests/fixtures/node-test-force-exit/runner-stops-reading.cjs runs 12 tests
// and stops its runner from reading before the last 5 are reported. With
// --test-force-exit, Node's file process exits with those 5 still queued on
// its stdout, so the runner reports 5 of 12 and exits 0 (nodejs/node#64833).
// The preload scripts/profile-precommit/node-test-blocking-stdout.cjs makes
// that stdout blocking, so the queue cannot form.
//
// The first case is a canary: it fails once the pinned Node includes the fix
// (nodejs/node#64875), and then the preload can go.
//
// Each case runs the real CLI (node --test, scripts/profile-precommit.mjs) and
// reads the reporter output it writes.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished } from 'vitest';
import gitObjectFixture from './helpers/git-object-fixture.cjs';
import reaper from './fixtures/storyboard-process-reaper.cjs';

// Children run asynchronously in their own process group, so the test's own
// timeout bounds them and teardown kills the group if the test ends first.
const teardown = { after: onTestFinished };

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = join(REPO_ROOT, 'tests', 'fixtures', 'node-test-force-exit', 'runner-stops-reading.cjs');
const PRELOAD = join(REPO_ROOT, 'scripts', 'profile-precommit', 'node-test-blocking-stdout.cjs');
const PROFILER = join(REPO_ROOT, 'scripts', 'profile-precommit.mjs');
const NODE = process.execPath;
const DECLARED = 12;

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// The profiler case runs git in a throwaway repository; inside a hook the
// inherited GIT_DIR must not reach it (tests/helpers/git-object-fixture.cjs).
let restoreGitEnv = () => {};
beforeAll(() => { restoreGitEnv = gitObjectFixture.isolateGitEnv({ identity: false }); });
afterAll(() => restoreGitEnv());

// With stdout blocking the fixture's file process waits for its runner to
// resume, which happens after this bound. Any bound gives a complete report
// then, so the blocking cases use a short one.
const BLOCKING_RESUME = { RUNNER_STOPS_READING_MAX_MS: '200' };

function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...extra };
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm_|NODE_OPTIONS$|NODE_TEST_CONTEXT$|VITEST|ADCP_PRECOMMIT_|HUSKY)/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

/** Runs the fixture under `node --test --test-force-exit` with a junit file reporter. */
async function runFixture(preload: string[], extraEnv: Record<string, string> = {}): Promise<{ status: number | null; testcases: string[] }> {
  const xml = join(tempDir('node-test-force-exit-'), 'report.xml');
  const result = await reaper.runChild(
    teardown,
    NODE,
    [...preload, '--test', '--test-force-exit', '--test-reporter=junit', `--test-reporter-destination=${xml}`, FIXTURE],
    { cwd: REPO_ROOT, env: childEnv(extraEnv) },
  );
  const text = readFileSync(xml, 'utf8');
  return { status: result.status, testcases: [...text.matchAll(/<testcase name="([^"]*)"/g)].map((m) => m[1]) };
}

describe('node --test --test-force-exit with a runner that stops reading', () => {
  it('reports only the tests whose events reached the runner and still exits 0 (canary for nodejs/node#64833)', async () => {
    const { status, testcases } = await runFixture([]);
    expect(status).toBe(0);
    expect(testcases).toEqual(['reported 1', 'reported 2', 'reported 3', 'reported 4', 'reported 5']);
  });

  it('reports every test when the file process preloads the blocking-stdout module', async () => {
    const { status, testcases } = await runFixture([`--require=${PRELOAD}`], BLOCKING_RESUME);
    expect(status).toBe(0);
    expect(testcases).toHaveLength(DECLARED);
    expect(testcases.slice(-5)).toEqual(['queued 6', 'queued 7', 'queued 8', 'queued 9', 'queued 10']);
  });
});

describe('profile-precommit run', () => {
  it('records every test of a --test-force-exit node:test command in node-test.json', async () => {
    const root = tempDir('profile-precommit-node-test-');
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'tests'));
    copyFileSync(FIXTURE, join(root, 'tests', 'runner-stops-reading.cjs'));
    writeFileSync(join(root, 'scripts', 'check-image-quality.sh'), '#!/bin/bash\nexit 0\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'profile-precommit-fixture', version: '0.0.0', private: true,
      scripts: {
        precommit: 'npm run test:runner-stops-reading',
        'test:runner-stops-reading': 'node --test --test-force-exit tests/runner-stops-reading.cjs',
      },
    }, null, 2));
    execFileSync('git', ['init', '-q'], { cwd: root });

    const result = await reaper.runChild(
      teardown,
      NODE,
      [PROFILER, 'run', '--root', root, '--server-unit', 'skip', '--only', 'runner-stops-reading', '--label', 'report', '--out', 'runs'],
      { cwd: root, env: childEnv(BLOCKING_RESUME) },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);

    const runDir = join(root, 'runs', readdirSync(join(root, 'runs'))[0]);
    const step = readdirSync(runDir).find((name) => /^\d{2}-test-runner-stops-reading$/.test(name));
    expect(step, readdirSync(runDir).join(', ')).toBeDefined();
    const report = JSON.parse(readFileSync(join(runDir, step!, 'node-test.json'), 'utf8'));
    const names = report.tests.map((t: { name: string; status: string }) => `${t.status} ${t.name}`);
    expect(names).toHaveLength(DECLARED);
    expect(names.every((n: string) => n.startsWith('passed '))).toBe(true);
  });
});
