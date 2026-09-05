import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFixedTraceDiagnosticCliArguments } from '../../../src/addie/eval/fixed-trace-diagnostic-cli.js';

describe('fixed-trace diagnostic CLI parser', () => {
  it('accepts only bounded dry-run forms', () => {
    expect(parseFixedTraceDiagnosticCliArguments(['--validate-only', '--providers=openai']))
      .toEqual({ validateOnly: true, providers: 'openai', architectureArm: undefined, suite: undefined, softMaxUsd: undefined, output: undefined, experimentPlan: undefined, trustedManifest: undefined });
    expect(parseFixedTraceDiagnosticCliArguments(['--validate-only=true']).validateOnly).toBe(true);
  });

  it.each([
    ['--validate-only=false'], ['--validate-onl'], ['--providers=openai', '--providers=google'],
    ['positional'], ['--judge-providers=openai'], ['--providers'], ['--suite=unknown'],
  ])('rejects unsafe option input %j', (args) => {
    expect(() => parseFixedTraceDiagnosticCliArguments(args)).toThrow();
  });

  it('validates a complete bare dry run without credentials, writes, or provider setup', () => {
    const output = resolve('/tmp/fixed-trace-diagnostic-cli-no-write.json');
    const result = execFileSync('npx', [
      'tsx', 'server/tests/manual/fixed-trace-provider-eval.ts', '--validate-only', '--providers=openai',
      '--architecture-arm=direct_generation', '--soft-max-usd=1', `--output=${output}`,
    ], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: '' } });
    const validated = result.split('\n').map((line) => {
      try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; }
    }).find((line) => line?.diagnosticOnly === true);
    expect(validated).toMatchObject({
      diagnosticOnly: true,
      validated: { providers: ['openai'], architectureArm: 'direct_generation', suite: 'canonical', softMaxUsd: 1, outputPath: output },
    });
    expect(existsSync(output)).toBe(false);
  }, 20_000);

  it('binds the reviewed hybrid evaluator suite only to the hybrid arm during validate-only planning', () => {
    const output = resolve('/tmp/fixed-trace-diagnostic-cli-hybrid-suite-no-write.json');
    const result = execFileSync('npx', [
      'tsx', 'server/tests/manual/fixed-trace-provider-eval.ts', '--validate-only', '--providers=openai',
      '--architecture-arm=deterministic_policy_llm_fallback_hybrid', '--suite=hybrid-evaluator', '--soft-max-usd=1', `--output=${output}`,
    ], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: '' } });
    expect(result).toContain('"suite":"hybrid-evaluator"');
    expect(() => execFileSync('npx', [
      'tsx', 'server/tests/manual/fixed-trace-provider-eval.ts', '--validate-only', '--providers=openai',
      '--architecture-arm=two_stage_llm_router', '--suite=hybrid-evaluator', '--soft-max-usd=1', `--output=${output}`,
    ], { cwd: process.cwd(), stdio: 'pipe' })).toThrow();
    expect(existsSync(output)).toBe(false);
  }, 20_000);

  it.each([
    ['--soft-max-usd=0', '--output=/tmp/out.json'],
    ['--experiment-plan=/tmp/no-plan.json'],
  ])('rejects malformed dry run configuration', (...args) => {
    expect(() => execFileSync('npx', [
      'tsx', 'server/tests/manual/fixed-trace-provider-eval.ts', '--validate-only', '--providers=openai', ...args,
    ], { cwd: process.cwd(), stdio: 'pipe' })).toThrow();
  });
});
