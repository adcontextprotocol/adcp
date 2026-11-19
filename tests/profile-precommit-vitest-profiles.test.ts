// `profile-precommit run --cpu-prof --heap-prof` must profile the test files
// of a vitest leaf that runs on the forks pool, as the root suite does.
//
// A forks-pool worker is stopped with SIGTERM, and Node writes its profile on
// that signal only when --cpu-prof or --heap-prof is in the worker's own
// execArgv (vitest's work-around for nodejs/node#55094); from NODE_OPTIONS
// alone the worker's profile is lost. The case runs the real CLI against a
// throwaway root with one test file and reads the profiles it writes.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import gitObjectFixture from './helpers/git-object-fixture.cjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILER = join(REPO_ROOT, 'scripts', 'profile-precommit.mjs');
const NODE = process.execPath;
// Named so it can be found in a profile: it runs only in the test file.
const MARKER_FUNCTION = 'profiledInForksWorker';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// The profiler runs git in the throwaway root; inside a hook the inherited
// GIT_DIR must not reach it (tests/helpers/git-object-fixture.cjs).
let restoreGitEnv = () => {};
beforeAll(() => { restoreGitEnv = gitObjectFixture.isolateGitEnv({ identity: false }); });
afterAll(() => restoreGitEnv());

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(npm_|NODE_OPTIONS$|VITEST|ADCP_PRECOMMIT_|ADCP_VITEST_|HUSKY)/i.test(key)) continue;
    env[key] = value;
  }
  return env;
}

/** Profile files under dir whose text names MARKER_FUNCTION. */
function profilesNamingMarker(dir: string, suffix: string): string[] {
  let names: string[] = [];
  try { names = readdirSync(dir).filter((n) => n.endsWith(suffix)); } catch { return []; }
  return names.filter((n) => readFileSync(join(dir, n), 'utf8').includes(`"functionName":"${MARKER_FUNCTION}"`));
}

describe('profile-precommit run', () => {
  it('writes CPU and heap profiles for the test files of a forks-pool vitest leaf', () => {
    const root = mkdtempSync(join(tmpdir(), 'profile-precommit-forks-'));
    dirs.push(root);
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'tests'));
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(root, 'node_modules'));
    writeFileSync(join(root, 'scripts', 'check-image-quality.sh'), '#!/bin/bash\nexit 0\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      name: 'profile-precommit-forks-fixture', version: '0.0.0', private: true,
      scripts: { precommit: 'npm run test:unit', 'test:unit': 'vitest run --dir tests/ --pool=forks' },
    }, null, 2));
    // Busy and allocating for 200 ms, so both samplers record the function.
    // The heap profile lists live allocations only, so they stay reachable.
    writeFileSync(join(root, 'tests', 'worker.test.ts'), [
      "import { expect, it } from 'vitest';",
      'const kept: object[] = [];',
      `function ${MARKER_FUNCTION}() {`,
      '  const end = Date.now() + 200;',
      '  while (Date.now() < end) kept.push({ at: Date.now(), text: String(kept.length) });',
      '  return kept.length;',
      '}',
      `it('runs in a forks worker', () => { expect(${MARKER_FUNCTION}()).toBeGreaterThan(0); });`,
      '',
    ].join('\n'));
    execFileSync('git', ['init', '-q'], { cwd: root });

    const result = spawnSync(
      NODE,
      [PROFILER, 'run', '--root', root, '--server-unit', 'skip', '--cpu-prof', '--heap-prof', '--label', 'forks', '--out', 'runs'],
      { cwd: root, env: childEnv(), encoding: 'utf8', timeout: 5_000 },
    );
    expect(result.status, result.stdout + result.stderr).toBe(0);

    const runDir = join(root, 'runs', readdirSync(join(root, 'runs'))[0]);
    const step = readdirSync(runDir).find((name) => /^\d{2}-test-unit$/.test(name));
    expect(step, readdirSync(runDir).join(', ')).toBeDefined();
    expect(profilesNamingMarker(join(runDir, step!, 'cpu'), '.cpuprofile'), 'CPU profile of the worker').toHaveLength(1);
    expect(profilesNamingMarker(join(runDir, step!, 'heap'), '.heapprofile'), 'heap profile of the worker').toHaveLength(1);
  });
});
