import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFixedTraceDiagnosticCliArguments } from '../../../src/addie/eval/fixed-trace-diagnostic-cli.js';

const REPOSITORY_ROOT = process.cwd();
const LOCAL_TSX_CLI = realpathSync(resolve(REPOSITORY_ROOT, 'node_modules/.bin/tsx'));
const LOCAL_TSX_EXPECTED = resolve(REPOSITORY_ROOT, 'node_modules/tsx/dist/cli.mjs');
const PROVIDER_FREE_ENV = { PATH: process.env.PATH ?? '', NODE_ENV: 'test' };

describe('fixed-trace dormant dispatch boundary', () => {
  it('refuses every runtime control except the bare validation flag', () => {
    expect(parseFixedTraceDiagnosticCliArguments([])).toEqual({ validateOnly: false });
    for (const values of [
      ['--providers=openai'], ['--output=/tmp/fixed-trace.json'],
      ['--validate-only=true'], ['--validate-only', '--suite=canonical'],
    ]) {
      expect(() => parseFixedTraceDiagnosticCliArguments(values)).toThrow(
        'accepts only the bare --validate-only flag',
      );
    }
  });

  it('runs the manual entrypoint only as declaration validation', () => {
    // Execute Node against this checkout's resolved tsx CLI, never npx. The
    // minimal environment deliberately omits every provider credential.
    expect(LOCAL_TSX_CLI).toBe(LOCAL_TSX_EXPECTED);
    const result = spawnSync(process.execPath, [
      LOCAL_TSX_CLI, 'server/tests/manual/fixed-trace-provider-eval.ts', '--validate-only',
    ], {
      cwd: REPOSITORY_ROOT, encoding: 'utf8', env: PROVIDER_FREE_ENV,
    });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout.trim())).toMatchObject({
      diagnosticOnly: true, dispatchable: false, outputWritten: false, providerCalls: 0,
    });
  });
});
