import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { childLaunchesExited, childLaunchesSince, launchedBeforeExitOf } from '../../helpers/child-process-launches.js';

// Pass-through recorder: both CLI children run for real; the guard reads when
// each was launched and when it exited (event order, not clock readings).
vi.mock('node:child_process', async (importOriginal) =>
  (await import('../../helpers/child-process-launches.js')).recordChildProcessLaunches(await importOriginal()));

const LOCAL_TSX_CLI = realpathSync(resolve(process.cwd(), 'node_modules/.bin/tsx'));

interface CliResult { readonly error: Error | null; readonly stdout: string; readonly stderr: string }

/** Runs the manual entrypoint with this checkout's tsx CLI (never npx) and settles, never rejects. */
function runProviderRouterCli(arguments_: readonly string[], env: NodeJS.ProcessEnv): Promise<CliResult> {
  return new Promise((resolveResult) => {
    execFile(process.execPath, [LOCAL_TSX_CLI, 'server/tests/manual/provider-router-eval.ts', ...arguments_], {
      cwd: process.cwd(), encoding: 'utf8', env, maxBuffer: 16 * 1024 * 1024,
    }, (error, stdout, stderr) => resolveResult({ error, stdout, stderr }));
  });
}

/** Same check as execFileSync: a non-zero exit fails with the child's output. */
function stdoutOf(result: CliResult): string {
  expect(result.error, `${result.stdout}\n${result.stderr}`).toBeNull();
  return result.stdout;
}

describe('provider router diagnostic CLI', () => {
  // The two validate-only children are independent, so both start here and
  // run in flight together; each test awaits its own.
  let openaiOnly: Promise<CliResult>;
  let allProviders: Promise<CliResult>;
  beforeAll(() => {
    openaiOnly = runProviderRouterCli(
      ['--validate-only', '--providers=openai', '--soft-max-usd=10'],
      { ...process.env, OPENAI_API_KEY: '' },
    );
    allProviders = runProviderRouterCli(
      ['--validate-only', '--providers=anthropic,openai,google', '--soft-max-usd=10'],
      { ...process.env, ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '', GEMINI_API_KEY: '' },
    );
  });

  it('validates the dated cohort before credentials or provider construction', async () => {
    const result = stdoutOf(await openaiOnly);
    const diagnostic = result.split('\n').map((line) => {
      try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; }
    }).find((line) => line?.diagnosticOnly === true);
    expect(diagnostic).toMatchObject({
      diagnosticOnly: true,
      validated: { providers: ['openai'], profiles: ['prompt_parity', 'native_structured'], repetitions: 3, softMaxUsd: 10 },
    });
  });

  it('inventories every selected matrix cell and its sole unsupported candidate without credentials', async () => {
    const result = stdoutOf(await allProviders);
    const diagnostic = result.split('\n').map((line) => {
      try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; }
    }).find((line) => line?.diagnosticOnly === true);
    expect(diagnostic).toMatchObject({
      diagnosticOnly: true,
      validated: {
        requestedCells: expect.arrayContaining([
          { provider: 'anthropic', profile: 'prompt_parity' },
          { provider: 'anthropic', profile: 'native_structured' },
          { provider: 'openai', profile: 'prompt_parity' },
          { provider: 'openai', profile: 'native_structured' },
          { provider: 'google', profile: 'prompt_parity' },
          { provider: 'google', profile: 'native_structured' },
        ]),
        plannedCells: expect.arrayContaining([
          { provider: 'anthropic', profile: 'prompt_parity' },
          { provider: 'openai', profile: 'prompt_parity' },
          { provider: 'openai', profile: 'native_structured' },
          { provider: 'google', profile: 'prompt_parity' },
          { provider: 'google', profile: 'native_structured' },
        ]),
        excludedCells: [{
          provider: 'anthropic', profile: 'native_structured',
          reason: 'anthropic_router_has_no_native_structured_profile',
        }],
      },
    });
  });

  it('runs both validate-only CLI children in flight together', async () => {
    // Both children are launched before any test body runs, and the second is
    // launched before the first exits, so the file's wall time is the slower
    // child, not the sum.
    expect(childLaunchesSince(0), 'both CLI children are launched before the tests that read them').toHaveLength(2);
    const [first, second] = await childLaunchesExited(0, 2);
    expect(launchedBeforeExitOf(second!, first!), 'the second CLI child is launched before the first exits').toBe(true);
  });
});
