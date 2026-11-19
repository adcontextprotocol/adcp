// The shared Node compile cache, on the pre-push storyboard path only:
//   - .husky/pre-push exports NODE_COMPILE_CACHE for everything it starts:
//     its export line, run in sh from a repository root, yields
//     <root>/node_modules/.cache/node-compile-cache, or a preset value.
// The pre-commit hook and the root vitest config do not set it: vitest runs
// test files and inlined source through its own module runner, which the
// cache does not cover, and no saving was measurable there.
// Each case runs the real line and asserts what the process sees; nothing
// here asserts on time.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import gitObjectFixture from './helpers/git-object-fixture.cjs';

const { fixtureEnv } = gitObjectFixture;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS = ['pre-push'];
const DEFAULT_CACHE = join('node_modules', '.cache', 'node-compile-cache');

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A throwaway git repository root, as a real path. */
function fixtureRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'node-compile-cache-')));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root, env: fixtureEnv({ identity: false }) });
  return root;
}

/** Child env without compile-cache settings or inherited test-runner state. */
function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(NODE_COMPILE_CACHE|NODE_DISABLE_COMPILE_CACHE|NODE_OPTIONS|VITEST.*|TEST|NODE_ENV|npm_.*)$/i.test(key)) continue;
    env[key] = value;
  }
  return { ...env, ...extra };
}

describe.each(HOOKS)('.husky/%s: NODE_COMPILE_CACHE', (hook) => {
  function exportLine(): string {
    const lines = readFileSync(join(REPO_ROOT, '.husky', hook), 'utf8').split('\n').filter((line) => /^\s*export NODE_COMPILE_CACHE=/.test(line));
    expect(lines, `one \`export NODE_COMPILE_CACHE=\` line in .husky/${hook}`).toHaveLength(1);
    return lines[0];
  }

  /** Runs the hook's export line in sh, as git runs the hook from the repository root. */
  function exported(root: string, env: NodeJS.ProcessEnv): string {
    const result = spawnSync('/bin/sh', ['-c', `${exportLine()}\nprintf '%s' "$NODE_COMPILE_CACHE"`], {
      cwd: root, env: { ...env, PWD: root }, encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  }

  it('exports <root>/node_modules/.cache/node-compile-cache when NODE_COMPILE_CACHE is unset', () => {
    const root = fixtureRepo();
    expect(exported(root, cleanEnv())).toBe(join(root, DEFAULT_CACHE));
  });

  it('keeps a preset NODE_COMPILE_CACHE', () => {
    const root = fixtureRepo();
    const preset = join(root, 'preset-compile-cache');
    expect(exported(root, cleanEnv({ NODE_COMPILE_CACHE: preset }))).toBe(preset);
  });
});
