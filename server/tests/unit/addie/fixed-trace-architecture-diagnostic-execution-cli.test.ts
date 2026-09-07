import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const tsx = realpathSync(resolve(root, 'node_modules/.bin/tsx'));
const providerFreeEnv = { PATH: process.env.PATH ?? '', NODE_ENV: 'test' };

function run(...arguments_: string[]) {
  return spawnSync(process.execPath, [tsx, 'server/tests/manual/fixed-trace-architecture-diagnostic-eval.ts', ...arguments_], {
    cwd: root, encoding: 'utf8', env: providerFreeEnv,
  });
}

describe('fixed-trace architecture diagnostic execution CLI', () => {
  it('validates the exact one-cell plan with no credential, output, selector, or provider setup', () => {
    const result = run('--validate-only');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      validateOnly: true, providerCalls: 0, selectorConsumed: false, outputWritten: false,
      plan: {
        cell: 'architecture_diagnostic:anthropic:claude-haiku-4-5:claude-sonnet-5',
        traceCount: 24, diagnosticOnly: true, comparisonEligible: false, formalExternalFinal: 'unavailable',
        wholeCellCostCeiling: { totalMaxDispatches: 168 },
      },
    });
  }, 20_000);

  it.each([
    ['--validate-only', '--output=/tmp/forbidden.json'],
    ['--validate-only', '--cell=forged'],
    ['--execute'],
    ['--validate-only', '--validate-only'],
  ])('rejects runtime selection or malformed paths %j', (...arguments_: string[]) => {
    const result = run(...arguments_);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
  });
});
