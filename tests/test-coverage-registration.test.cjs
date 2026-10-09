#!/usr/bin/env node
'use strict';

/**
 * Every test file in the repository must be run by CI, or be listed in
 * tests/test-coverage-allowlist.json with a reason.
 *
 * "Run by CI" is computed statically from the sources CI actually executes:
 *
 *   1. Every `run:` step of a workflow triggered by pull_request, push, or
 *      merge_group is split into shell commands.
 *   2. `npm run <script>` / `npm test` is followed recursively through the
 *      package.json of the step's working directory.
 *      `node scripts/run-test-stage-shard.mjs` expands to every stage of
 *      `scripts.test` it does not `--exclude`.
 *   3. `node --test <files>`, `node <file>`, and `tsx <file>` reach the files
 *      they name.
 *   4. `vitest run ...` reaches what `vitest list --filesOnly` reports for the
 *      same config, --dir/--root/--exclude, and path filters. A package whose
 *      Vite config has no `test` block uses vitest's default include, resolved
 *      here without loading the config (its plugins may not be installed).
 *
 * Commands inside reached npm scripts must be understood. An unfamiliar
 * command or flag fails the check instead of being skipped, so a new runner
 * shape has to be taught here before it can count as coverage.
 */

const { execFile, execFileSync } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const YAML = require('yaml');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOWS_DIR = path.join(ROOT, '.github', 'workflows');
const ALLOWLIST_PATH = path.join(__dirname, 'test-coverage-allowlist.json');

const CI_TRIGGERS = new Set(['pull_request', 'push', 'merge_group']);
const SKIPPED_DIRS = new Set(['node_modules', 'dist', '.git', '.context', '.venv']);
const TEST_FILE_PATTERNS = [
  /\.(test|spec)\.[cm]?[jt]sx?$/, // vitest, node:test, and plain-script suites
  /^tests\/.*\.node\.mjs$/, // node:test suites kept out of vitest's glob
  /^tests\/e2e\/.*\.smoke\.js$/, // Playwright smoke scripts
];
// vitest's default `test.include`.
const VITEST_DEFAULT_INCLUDE = /\.(test|spec)\.[cm]?[jt]sx?$/;

// Commands in reached npm scripts that cannot run a repository test file.
const LEAF_COMMANDS = new Set(['tsc', 'tsr', 'biome', 'vite', 'echo', 'exit', 'git', 'true', 'false']);
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', 'exec', 'time']);

const toPosix = (p) => p.split(path.sep).join('/');
const repoRelative = (absolute) => toPosix(path.relative(ROOT, absolute));
const isTestFile = (relative) => TEST_FILE_PATTERNS.some((pattern) => pattern.test(relative));

// ---------------------------------------------------------------------------
// Test file inventory
// ---------------------------------------------------------------------------

function listTestFiles() {
  // Tracked plus untracked-but-not-ignored files, so a new suite is caught
  // before it is committed.
  const output = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const files = new Set();
  for (const file of output.split('\0')) {
    if (!file || file.split('/').some((segment) => SKIPPED_DIRS.has(segment))) continue;
    if (!isTestFile(file)) continue;
    if (!fs.existsSync(path.join(ROOT, file))) continue; // deleted in the worktree
    files.add(file);
  }
  return files;
}

// ---------------------------------------------------------------------------
// Shell parsing (enough for this repository's scripts and workflow steps)
// ---------------------------------------------------------------------------

/** Joins continuation lines and drops heredoc bodies. */
function stripHeredocs(script) {
  const lines = [];
  let heredocEnd = null;
  let pending = '';
  for (const line of script.split('\n')) {
    if (heredocEnd !== null) {
      if (line.trim() === heredocEnd) heredocEnd = null;
      continue;
    }
    const heredoc = /<<-?\s*['"]?(\w+)['"]?/.exec(line);
    if (heredoc) heredocEnd = heredoc[1];
    if (line.endsWith('\\')) {
      pending += `${line.slice(0, -1)} `;
      continue;
    }
    lines.push(pending + line);
    pending = '';
  }
  if (pending) lines.push(pending);
  return lines.join('\n');
}

/**
 * Splits shell text into simple commands (arrays of words) on newlines and
 * && || | ; ( ). Quotes may span lines.
 */
function simpleCommands(text) {
  const commands = [];
  let words = [];
  let word = '';
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" || ch === '"') {
      const close = text.indexOf(ch, i + 1);
      if (close === -1) throw new Error(`Unbalanced ${ch} in: ${text}`);
      word += text.slice(i + 1, close);
      inWord = true;
      i = close;
    } else if (ch === '#' && !inWord) {
      const newline = text.indexOf('\n', i);
      i = newline === -1 ? text.length : newline - 1;
    } else if (ch === '\n' || ch === ';' || ch === '(' || ch === ')') {
      endCommand();
    } else if (/\s/.test(ch)) {
      endWord();
    } else if ((ch === '&' || ch === '|') && text[i + 1] === ch) {
      endCommand();
      i += 1;
    } else if (ch === '|') {
      endCommand();
    } else {
      word += ch;
      inWord = true;
    }
  }
  endCommand();
  return commands;
}

function splitShell(script) {
  return simpleCommands(stripHeredocs(script));
}

/** Drops leading VAR=value assignments, shell keywords, and redirections. */
function normalizeWords(words) {
  let start = 0;
  while (
    start < words.length &&
    (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start]) || SHELL_KEYWORDS.has(words[start]))
  ) {
    start += 1;
  }
  return words.slice(start).filter((word) => !/^\d*[<>]/.test(word));
}

// ---------------------------------------------------------------------------
// Coverage resolution
// ---------------------------------------------------------------------------

class CoverageResolver {
  constructor() {
    this.reached = new Map(); // repo-relative file -> first CI source that reaches it
    this.vitestQueries = [];
    this.visitedScripts = new Set();
    this.packages = new Map();
  }

  packageScripts(cwd) {
    if (!this.packages.has(cwd)) {
      const file = path.join(cwd, 'package.json');
      if (!fs.existsSync(file)) throw new Error(`No package.json in ${repoRelative(cwd) || '.'}`);
      this.packages.set(cwd, JSON.parse(fs.readFileSync(file, 'utf8')).scripts ?? {});
    }
    return this.packages.get(cwd);
  }

  markFile(cwd, file, source) {
    const absolute = path.resolve(cwd, file);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return false;
    const relative = repoRelative(absolute);
    if (!this.reached.has(relative)) this.reached.set(relative, source);
    return true;
  }

  /**
   * @param {string} script shell text
   * @param {object} context { cwd, source, strict, extraArgs }
   *   strict: every command must be understood (npm script bodies).
   *   extraArgs: arguments npm appends after `--` (added to the last command).
   */
  runScript(script, { cwd, source, strict, extraArgs = [] }) {
    const commands = splitShell(script).map(normalizeWords).filter((words) => words.length);
    commands.forEach((words, index) => {
      const args = index === commands.length - 1 ? [...words, ...extraArgs] : words;
      this.runCommand(args, { cwd, source, strict });
    });
  }

  runCommand(words, context) {
    const [head, ...args] = words;
    const fail = (why) => {
      throw new Error(
        `test-coverage-registration cannot interpret \`${words.join(' ')}\` (${context.source}): ${why}. ` +
          'Teach tests/test-coverage-registration.test.cjs this invocation shape.',
      );
    };
    switch (head) {
      case 'npm':
        return this.runNpm(args, context, fail);
      case 'npx':
        return this.runNpx(args, context, fail);
      case 'node':
        return this.runNode(args, context, fail);
      case 'tsx':
        return this.runTsx(args, context, fail);
      case 'vitest':
        return this.runVitest(args, context, fail);
      default:
        if (!context.strict || LEAF_COMMANDS.has(head)) return undefined;
        if ((head === 'bash' || head === 'sh') && args[0] && !args[0].startsWith('-')) {
          // A shell script is a leaf: tests reached only through it are not
          // counted, so the check fails safe instead of guessing.
          return undefined;
        }
        return fail('unknown command');
    }
  }

  runNpm(args, context, fail) {
    if (args[0] === '--prefix') {
      const cwd = path.resolve(context.cwd, args[1] ?? '');
      // Workflows use --prefix for checkouts of other repositories.
      if (!context.strict && !fs.existsSync(path.join(cwd, 'package.json'))) return;
      return this.runNpm(args.slice(2), { ...context, cwd }, fail);
    }
    const [subcommand, ...rest] = args;
    let scriptName;
    let tail;
    if (subcommand === 'run' || subcommand === 'run-script') {
      [scriptName, ...tail] = rest;
      if (!scriptName || scriptName.startsWith('-')) fail('expected a script name after npm run');
    } else if (subcommand === 'test' || subcommand === 't') {
      scriptName = 'test';
      tail = rest;
    } else if (['ci', 'install', 'audit', 'pkg', 'view', 'pack', 'publish'].includes(subcommand)) {
      return;
    } else {
      fail('unsupported npm subcommand');
    }
    if (tail.length && tail[0] !== '--') fail('npm script arguments must follow --');
    this.runNpmScript(scriptName, context, tail.slice(1), fail);
  }

  runNpmScript(scriptName, context, extraArgs, fail) {
    const scripts = this.packageScripts(context.cwd);
    if (typeof scripts[scriptName] !== 'string') fail(`no "${scriptName}" script in that package.json`);
    const key = `${context.cwd}\0${scriptName}\0${extraArgs.join(' ')}`;
    if (this.visitedScripts.has(key)) return;
    this.visitedScripts.add(key);
    const where = repoRelative(context.cwd);
    this.runScript(scripts[scriptName], {
      cwd: context.cwd,
      source: `${context.source} > npm run ${scriptName}${where ? ` (${where})` : ''}`,
      strict: true,
      extraArgs,
    });
  }

  runNpx(args, context, fail) {
    const rest = args.filter((arg) => arg !== '--yes' && arg !== '-y' && arg !== '--no-install');
    const [tool, ...toolArgs] = rest;
    if (tool === 'vitest') return this.runVitest(toolArgs, context, fail);
    if (tool === 'tsx') return this.runTsx(toolArgs, context, fail);
    return undefined; // an external tool (changesets, tsc, markdown-link-check, ...)
  }

  runNode(args, context, fail) {
    if (args.some((arg) => ['-e', '-p', '--eval', '--print'].includes(arg) || arg.startsWith('--input-type'))) {
      return; // inline code
    }
    const valueFlags = new Set(['--import', '--require', '-r', '--loader', '--test-reporter', '--test-name-pattern']);
    const positional = [];
    let testMode = false;
    for (let i = 0; i < args.length; i += 1) {
      const arg = args[i];
      if (arg === '--test') testMode = true;
      if (arg.startsWith('-') && positional.length === 0) {
        if (valueFlags.has(arg)) i += 1;
        continue;
      }
      if (!testMode && positional.length > 0) break; // arguments to the entry script
      if (testMode && arg.startsWith('-')) continue;
      positional.push(arg);
    }
    if (positional.length === 0) {
      if (testMode) fail('node --test without explicit files uses default discovery');
      return; // stdin / heredoc
    }
    if (!testMode && toPosix(positional[0]) === 'scripts/run-test-stage-shard.mjs') {
      return this.runTestStageShard(args, context, fail);
    }
    for (const file of positional) {
      const found = this.markFile(context.cwd, file, context.source);
      if (!found && testMode) fail(`test file ${file} does not exist`);
    }
  }

  runTestStageShard(args, context, fail) {
    const excluded = new Set();
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--exclude') excluded.add(args[i + 1]);
    }
    const testScript = this.packageScripts(context.cwd).test;
    // Mirrors scripts/run-test-stage-shard.mjs: scripts.test is a list of
    // `npm run <stage>` clauses, and the matrix together runs every shard.
    for (const clause of testScript.split(/\s+&&\s+/)) {
      const match = /^npm run (\S+)$/.exec(clause.trim());
      if (!match) fail(`unsupported scripts.test clause ${JSON.stringify(clause)}`);
      if (excluded.has(match[1])) continue;
      this.runNpmScript(match[1], { ...context, source: `${context.source} > test stage` }, [], fail);
    }
  }

  runTsx(args, context, fail) {
    const rest = args[0] === 'watch' ? args.slice(1) : args;
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '--import' || rest[i] === '--require') {
        i += 1;
      } else if (rest[i].startsWith('-')) {
        fail('unsupported tsx flag');
      } else {
        this.markFile(context.cwd, rest[i], context.source);
        return;
      }
    }
  }

  runVitest(args, context, fail) {
    const rest = args[0] === 'run' ? args.slice(1) : args;
    if (rest[0] && !rest[0].startsWith('-') && ['watch', 'dev', 'related', 'bench', 'list'].includes(rest[0])) {
      fail(`unsupported vitest subcommand ${rest[0]}`);
    }
    const query = { cwd: context.cwd, source: context.source, config: null, dir: null, root: null, exclude: [], filters: [] };
    // Flags that only change how selected files run, not which files.
    const ignoredWithValue = new Set(['--pool', '--testTimeout', '--hookTimeout', '--shard', '--reporter', '--maxWorkers']);
    const ignoredBoolean = new Set(['--passWithNoTests', '--silent', '--no-file-parallelism', '--bail']);
    for (let i = 0; i < rest.length; i += 1) {
      const [flag, inlineValue] = rest[i].startsWith('--') ? rest[i].split(/=(.*)/s, 2) : [rest[i], undefined];
      const takeValue = () => {
        if (inlineValue !== undefined) return inlineValue;
        i += 1;
        if (rest[i] === undefined) fail(`${flag} needs a value`);
        return rest[i];
      };
      if (!flag.startsWith('-')) query.filters.push(flag);
      else if (flag === '--config' || flag === '-c') query.config = takeValue();
      else if (flag === '--dir') query.dir = takeValue();
      else if (flag === '--root' || flag === '-r') query.root = takeValue();
      else if (flag === '--exclude') query.exclude.push(takeValue());
      else if (ignoredWithValue.has(flag)) takeValue();
      else if (ignoredBoolean.has(flag) || flag.startsWith('--poolOptions.')) continue;
      else fail(`unsupported vitest flag ${flag}`);
    }
    this.vitestQueries.push(query);
  }

  async resolveVitestQueries() {
    await Promise.all(this.vitestQueries.map(async (query) => {
      const files = hasTestBlock(query) ? await vitestList(query) : defaultVitestFiles(query);
      if (files.length === 0) throw new Error(`vitest invocation reaches no files (${query.source})`);
      for (const file of files) this.markFile(query.cwd, file, query.source);
    }));
  }
}

function vitestConfigFile(query) {
  if (query.config) return path.resolve(query.cwd, query.config);
  const base = path.resolve(query.cwd, query.root ?? '.');
  for (const name of ['vitest.config', 'vite.config']) {
    for (const ext of ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs']) {
      const candidate = path.join(base, name + ext);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function hasTestBlock(query) {
  const config = vitestConfigFile(query);
  return config !== null && /\btest\s*:/.test(fs.readFileSync(config, 'utf8'));
}

/** vitest defaults for a package whose config sets no `test` options. */
function defaultVitestFiles(query) {
  if (query.exclude.length) throw new Error(`--exclude without a vitest test config is not modeled (${query.source})`);
  const base = path.resolve(query.cwd, query.root ?? '.', query.dir ?? '.');
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (VITEST_DEFAULT_INCLUDE.test(entry.name)) files.push(full);
    }
  };
  walk(base);
  return files.filter((file) => {
    const relative = toPosix(path.relative(path.resolve(query.cwd, query.root ?? '.'), file));
    return query.filters.length === 0 || query.filters.some((filter) => relative.includes(filter) || toPosix(file).includes(filter));
  });
}

async function vitestList(query) {
  const bin = path.join(path.dirname(require.resolve('vitest/package.json')), 'vitest.mjs');
  const args = [bin, 'list', '--filesOnly'];
  if (query.config) args.push('--config', query.config);
  if (query.root) args.push('--root', query.root);
  if (query.dir) args.push('--dir', query.dir);
  for (const pattern of query.exclude) args.push('--exclude', pattern);
  args.push(...query.filters);
  let stdout;
  try {
    ({ stdout } = await promisify(execFile)(process.execPath, args, {
      cwd: query.cwd,
      env: { ...process.env, VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true', CI: 'true' },
      maxBuffer: 16 * 1024 * 1024,
    }));
  } catch (error) {
    throw new Error(`vitest list failed for ${query.source}: ${error.stderr || error.message}`);
  }
  return stdout.split('\n').map((line) => line.trim()).filter((line) => VITEST_DEFAULT_INCLUDE.test(line));
}

function ciSteps() {
  const steps = [];
  for (const name of fs.readdirSync(WORKFLOWS_DIR).filter((file) => /\.ya?ml$/.test(file)).sort()) {
    const workflow = YAML.parse(fs.readFileSync(path.join(WORKFLOWS_DIR, name), 'utf8'));
    const on = workflow.on ?? {};
    const triggers = typeof on === 'string' ? [on] : Array.isArray(on) ? on : Object.keys(on);
    if (!triggers.some((trigger) => CI_TRIGGERS.has(trigger))) continue;
    for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
      const jobDir = job.defaults?.run?.['working-directory'] ?? workflow.defaults?.run?.['working-directory'];
      for (const step of job.steps ?? []) {
        if (typeof step.run !== 'string') continue;
        const dir = step['working-directory'] ?? jobDir ?? '.';
        const normalized = String(dir).replace(/^\$\{\{\s*github\.workspace\s*\}\}/, '.');
        if (normalized.includes('${{')) {
          throw new Error(`Unsupported working-directory ${dir} in ${name} job ${jobId}`);
        }
        steps.push({
          script: step.run,
          cwd: path.resolve(ROOT, normalized),
          source: `${name} > ${jobId} > ${step.name ?? step.run.split('\n')[0]}`,
        });
      }
    }
  }
  return steps;
}

async function computeCiCoverage() {
  const resolver = new CoverageResolver();
  for (const step of ciSteps()) {
    resolver.runScript(step.script, { cwd: step.cwd, source: step.source, strict: false });
  }
  await resolver.resolveVitestQueries();
  return resolver.reached;
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

function loadAllowlist() {
  const { entries } = JSON.parse(fs.readFileSync(ALLOWLIST_PATH, 'utf8'));
  return entries.map((entry) => ({
    ...entry,
    matches: entry.path.endsWith('/**')
      ? (file) => file.startsWith(entry.path.slice(0, -2))
      : (file) => file === entry.path,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let analysisPromise;
function analysis() {
  analysisPromise ??= (async () => {
    const testFiles = listTestFiles();
    const reached = await computeCiCoverage();
    const allowlist = loadAllowlist();
    const unreached = [...testFiles].filter((file) => !reached.has(file)).sort();
    return { testFiles, reached, allowlist, unreached };
  })();
  return analysisPromise;
}

test('every test file is run by CI or allowlisted with a reason', async () => {
  const { unreached, allowlist } = await analysis();
  const uncovered = unreached.filter((file) => !allowlist.some((entry) => entry.matches(file)));
  assert.deepEqual(
    uncovered,
    [],
    `${uncovered.length} test file(s) are not run by any CI workflow:\n` +
      uncovered.map((file) => `  - ${file}`).join('\n') +
      '\n\nRun each one from a script in the `npm test` chain (for example, add a root tests/*.test.cjs ' +
      'suite to `test:contracts` in package.json), or add it to tests/test-coverage-allowlist.json with the ' +
      'reason CI cannot run it.',
  );
});

test('allowlist entries have reasons and are not stale', async () => {
  const { testFiles, unreached, allowlist } = await analysis();
  const problems = [];
  const seen = new Set();
  for (const entry of allowlist) {
    if (seen.has(entry.path)) problems.push(`${entry.path}: duplicate entry`);
    seen.add(entry.path);
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 10) {
      problems.push(`${entry.path}: needs a reason`);
    }
    if (![...testFiles].some(entry.matches)) {
      problems.push(`${entry.path}: matches no test file; remove the entry`);
    } else if (!unreached.some(entry.matches)) {
      problems.push(`${entry.path}: CI now runs this; remove the entry`);
    }
  }
  assert.deepEqual(problems, [], `Stale or invalid entries in tests/test-coverage-allowlist.json:\n  ${problems.join('\n  ')}`);
});

test('the shell splitter understands the shapes used in package.json and workflows', () => {
  assert.deepEqual(splitShell('a && b || (echo x && exit 1)'), [['a'], ['b'], ['echo', 'x'], ['exit', '1']]);
  assert.deepEqual(splitShell("node --test 'a b.cjs' # c"), [['node', '--test', 'a b.cjs']]);
  assert.deepEqual(splitShell('x \\\n  --y\nnode <<NODE\nnpm run nope\nNODE\nz | tee f'), [
    ['x', '--y'],
    ['node', '<<NODE'],
    ['z'],
    ['tee', 'f'],
  ]);
  assert.deepEqual(normalizeWords(['FOO=1', 'if', 'npx', 'tsx', 'a.ts', '2>&1']), ['npx', 'tsx', 'a.ts']);
});
