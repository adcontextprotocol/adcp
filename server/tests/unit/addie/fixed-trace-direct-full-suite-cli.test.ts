import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const tsx = realpathSync(resolve(root, 'node_modules/.bin/tsx'));

describe('fixed-trace direct full-suite CLI', () => {
  it('binds real provider calls to the explicit full-suite receipt policy', () => {
    const source = readFileSync(resolve(root, 'server/tests/manual/fixed-trace-direct-full-suite-eval.ts'), 'utf8');
    expect(source).toContain('fixedTraceDirectFullSuiteResponsePricingPolicy(provider.id, model, pricing)');
    expect(source).not.toContain('fixedTraceResponsePricingPolicy(provider.id, model, pricing)');
  });

  it('keeps validate-only provider-free and stdout to one exact JSON line', () => {
    const result = spawnSync(process.execPath, [
      tsx, 'server/tests/manual/fixed-trace-direct-full-suite-eval.ts', '--validate-only',
      '--cell=generation:google:gemini-3.7-flash:high', '--soft-max-usd=300',
      '--output=/tmp/addie-full-suite.json', '--selector=/tmp/addie-full-suite.used',
    ], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' } });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      validateOnly: true, providerCalls: 0, outputWritten: false, selectorConsumed: false,
      plan: { mode: 'direct_full_suite_model_comparison_v1', traceCount: 32, requiredJudgeProviders: ['anthropic', 'openai'], wholeCellCostCeiling: { totalUsd: expect.any(Number) } },
    });
  }, 20_000);

  it('rejects an impossible whole-cell cap without consuming selector or output', () => {
    const suffix = `${process.pid}-${Date.now()}`;
    const output = `/tmp/addie-full-suite-${suffix}.json`;
    const selector = `/tmp/addie-full-suite-${suffix}.used`;
    const result = spawnSync(process.execPath, [
      tsx, 'server/tests/manual/fixed-trace-direct-full-suite-eval.ts', '--validate-only',
      '--cell=generation:google:gemini-3.7-flash:high', '--soft-max-usd=0.000001',
      `--output=${output}`, `--selector=${selector}`,
    ], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', NODE_ENV: 'test' } });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('whole-cell ceiling');
    expect(() => realpathSync(output)).toThrow();
    expect(() => realpathSync(selector)).toThrow();
  }, 20_000);
});
