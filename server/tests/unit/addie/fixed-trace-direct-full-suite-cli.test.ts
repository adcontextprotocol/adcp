import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = process.cwd();
const tsx = realpathSync(resolve(root, 'node_modules/.bin/tsx'));

type EntryIo = { log: (...values: unknown[]) => void };
type EntryMain = (argv: readonly string[], io?: EntryIo) => Promise<unknown>;

/** The entrypoint must export main(argv, io) and must not run on import. */
async function importEntryMain(): Promise<EntryMain> {
  let entry: Record<string, unknown> | undefined;
  let importError: unknown;
  try {
    entry = await import('../../manual/fixed-trace-direct-full-suite-eval.js') as Record<string, unknown>;
  } catch (error) {
    importError = error;
  }
  expect(importError, 'importing the entrypoint must not run the CLI (direct-invocation guard)').toBeUndefined();
  expect(entry?.main, 'the entrypoint exports main(argv, io)').toBeTypeOf('function');
  return entry!.main as EntryMain;
}

const CONSOLE_METHODS = [
  'log', 'info', 'warn', 'error', 'debug', 'trace', 'dir', 'dirxml', 'table',
  'group', 'groupCollapsed', 'assert', 'count', 'timeLog', 'timeEnd',
] as const;

// The child tests run with env { PATH, NODE_ENV: 'test' }. In-process runs
// get the same environment: provider credentials blank, every other variable
// unset for the call except PATH and the test runner's own, so a third-party
// module cannot write because of the caller's shell environment.
const KEPT_ENV = /^(?:PATH|NODE_ENV|LOG_LEVEL|TEST|VITEST.*)$/;
const PROVIDER_CREDENTIALS = ['ANTHROPIC_API_KEY', 'ADDIE_ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'];

/**
 * Runs main() in this process with the child tests' environment and records
 * the io records plus every other write main makes to stdout, stderr or the
 * console. process.exit is trapped: main returns, only the wrapper exits.
 */
async function runInProcess(argv: readonly string[]) {
  for (const name of Object.keys(process.env)) if (!KEPT_ENV.test(name)) vi.stubEnv(name, undefined);
  for (const name of PROVIDER_CREDENTIALS) vi.stubEnv(name, '');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('LOG_LEVEL', 'silent');
  const main = await importEntryMain();
  const records: unknown[][] = [];
  const otherWrites: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => { otherWrites.push(`stdout: ${String(chunk)}`); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => { otherWrites.push(`stderr: ${String(chunk)}`); return true; });
  for (const method of CONSOLE_METHODS) {
    vi.spyOn(console, method).mockImplementation((...values: unknown[]) => { otherWrites.push(`console.${method}: ${values.map(String).join(' ')}`); });
  }
  const exitCalls: unknown[] = [];
  vi.spyOn(process, 'exit').mockImplementation((code?: unknown) => {
    exitCalls.push(code);
    throw new Error(`main called process.exit(${String(code)})`);
  });
  let outcome: { ok: true } | { ok: false; error: unknown };
  try {
    await main(argv, { log: (...values: unknown[]) => { records.push(values); } });
    outcome = { ok: true };
  } catch (error) {
    outcome = { ok: false, error };
  } finally {
    vi.restoreAllMocks();
  }
  return { outcome, records, otherWrites, exitCalls };
}

interface CliResult { readonly status: number | null; readonly stdout: string; readonly stderr: string }

/** Entrypoint children still running; afterAll stops any a failed or skipped test left behind. */
const runningChildren = new Set<ChildProcess>();

/** The manual entrypoint under this checkout's tsx with no provider credential in its environment. */
function runEntryChild(arguments_: readonly string[]): Promise<CliResult> {
  // Settles, never rejects: the promise starts in beforeAll and a test awaits it.
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [tsx, 'server/tests/manual/fixed-trace-direct-full-suite-eval.ts', ...arguments_], {
      cwd: root, env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    runningChildren.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', (error) => resolveResult({ status: null, stdout, stderr: `${stderr}${String(error)}` }));
    child.once('close', (status) => { runningChildren.delete(child); resolveResult({ status, stdout, stderr }); });
  });
}

function uniquePaths() {
  const directory = mkdtempSync(join(tmpdir(), 'addie-full-suite-in-process-'));
  return { directory, output: join(directory, 'addie-full-suite.json'), selector: join(directory, 'addie-full-suite.used') };
}

describe('fixed-trace direct full-suite CLI', () => {
  it('binds real provider calls to the explicit full-suite receipt policy', () => {
    const source = readFileSync(resolve(root, 'server/tests/manual/fixed-trace-direct-full-suite-eval.ts'), 'utf8');
    expect(source).toContain('fixedTraceDirectFullSuiteResponsePricingPolicy(provider.id, model, pricing)');
    expect(source).not.toContain('fixedTraceResponsePricingPolicy(provider.id, model, pricing)');
  });

  // The process boundary is what these two children check: exit status, an
  // empty stderr and exactly one stdout line at the file-descriptor level (the
  // logger writes to fd 1 directly, which no in-process spy can see). One
  // validate-only cell and the ceiling rejection keep that boundary; the
  // per-cell plans are checked in-process below. Both children are
  // independent, so they run in flight together.
  const PROCESS_CELL = 'generation:google:gemini-3.8-flash:provider_default';
  let validateChild: Promise<CliResult>;
  let ceilingChild: Promise<CliResult>;
  const childPaths = { validate: uniquePaths(), ceiling: uniquePaths() };
  beforeAll(() => {
    validateChild = runEntryChild([
      '--validate-only', `--cell=${PROCESS_CELL}`, '--soft-max-usd=2000',
      `--output=${childPaths.validate.output}`, `--selector=${childPaths.validate.selector}`,
    ]);
    ceilingChild = runEntryChild([
      '--validate-only', '--cell=generation:google:gemini-3.7-flash:high', '--soft-max-usd=0.000001',
      `--output=${childPaths.ceiling.output}`, `--selector=${childPaths.ceiling.selector}`,
    ]);
  });
  afterAll(async () => {
    // The tests await both children; one still running here belongs to a test
    // that failed early or was filtered out, so stop it instead of waiting.
    for (const child of runningChildren) child.kill('SIGKILL');
    await Promise.all([validateChild, ceilingChild]);
    for (const paths of Object.values(childPaths)) rmSync(paths.directory, { recursive: true, force: true });
  });

  it.each([PROCESS_CELL])('keeps validate-only provider-free and stdout to one exact JSON line for %s', async (cell) => {
    const result = await validateChild;
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      validateOnly: true, providerCalls: 0, outputWritten: false, selectorConsumed: false,
      plan: { mode: 'direct_full_suite_model_comparison_v1', cell, traceCount: 32, requiredJudgeProviders: expect.any(Array), wholeCellCostCeiling: { totalUsd: expect.any(Number) } },
    });
    expect(existsSync(childPaths.validate.output)).toBe(false);
    expect(existsSync(childPaths.validate.selector)).toBe(false);
  }, 20_000);

  it('rejects an impossible whole-cell cap without consuming selector or output', async () => {
    const { output, selector } = childPaths.ceiling;
    const result = await ceilingChild;
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('whole-cell ceiling');
    expect(() => realpathSync(output)).toThrow();
    expect(() => realpathSync(selector)).toThrow();
  }, 20_000);
});

describe('fixed-trace direct full-suite main() in-process', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it.each([
    'generation:anthropic:claude-opus-5:provider_default',
    'generation:openai:gpt-5.6-luna:provider_default',
    'generation:openai:gpt-5.6-terra:provider_default',
    'generation:openai:gpt-5.6-sol:provider_default',
  ])('in-process: validate-only for %s emits exactly one io record, writes nothing else and consumes no file', async (cell) => {
    const paths = uniquePaths();
    try {
      const run = await runInProcess([
        '--validate-only', `--cell=${cell}`, '--soft-max-usd=2000',
        `--output=${paths.output}`, `--selector=${paths.selector}`,
      ]);
      expect(run.outcome).toEqual({ ok: true });
      expect(run.exitCalls).toEqual([]);
      expect(run.otherWrites).toEqual([]);
      expect(run.records).toHaveLength(1);
      expect(run.records[0]).toHaveLength(1);
      const record = run.records[0]![0];
      expect(record).toBeTypeOf('string');
      expect((record as string).includes('\n')).toBe(false);
      expect(JSON.parse(record as string)).toMatchObject({
        validateOnly: true, providerCalls: 0, outputWritten: false, selectorConsumed: false,
        plan: { mode: 'direct_full_suite_model_comparison_v1', cell, traceCount: 32, requiredJudgeProviders: expect.any(Array), wholeCellCostCeiling: { totalUsd: expect.any(Number) } },
      });
      expect(existsSync(paths.output)).toBe(false);
      expect(existsSync(`${paths.output}.sha256`)).toBe(false);
      expect(existsSync(paths.selector)).toBe(false);
    } finally {
      rmSync(paths.directory, { recursive: true, force: true });
    }
  });

  it('in-process: rejects an impossible whole-cell cap without an io record, any write, or consuming selector or output', async () => {
    const paths = uniquePaths();
    try {
      const run = await runInProcess([
        '--validate-only', '--cell=generation:google:gemini-3.7-flash:high', '--soft-max-usd=0.000001',
        `--output=${paths.output}`, `--selector=${paths.selector}`,
      ]);
      expect(run.outcome).toMatchObject({ ok: false, error: expect.objectContaining({ message: expect.stringMatching(/whole-cell ceiling/) }) });
      expect(run.exitCalls).toEqual([]);
      expect(run.records).toEqual([]);
      expect(run.otherWrites).toEqual([]);
      expect(existsSync(paths.output)).toBe(false);
      expect(existsSync(`${paths.output}.sha256`)).toBe(false);
      expect(existsSync(paths.selector)).toBe(false);
    } finally {
      rmSync(paths.directory, { recursive: true, force: true });
    }
  });
});
