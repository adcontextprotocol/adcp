import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('provider router diagnostic CLI', () => {
  it('validates the dated cohort before credentials or provider construction', () => {
    const result = execFileSync('npx', [
      'tsx', 'server/tests/manual/provider-router-eval.ts',
      '--validate-only', '--providers=openai', '--soft-max-usd=10',
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, OPENAI_API_KEY: '' },
    });
    const diagnostic = result.split('\n').map((line) => {
      try { return JSON.parse(line) as Record<string, unknown>; } catch { return null; }
    }).find((line) => line?.diagnosticOnly === true);
    expect(diagnostic).toMatchObject({
      diagnosticOnly: true,
      validated: { providers: ['openai'], profiles: ['prompt_parity', 'native_structured'], repetitions: 3, softMaxUsd: 10 },
    });
  });
});
