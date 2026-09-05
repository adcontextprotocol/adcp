import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { reserveFixedTraceDiagnosticOutput } from '../../../src/addie/eval/fixed-trace-diagnostic-output.js';

describe('fixed-trace diagnostic output reservation', () => {
  it('never overwrites an existing artifact', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fixed-trace-output-')), 'artifact.json');
    writeFileSync(path, 'existing');
    expect(() => reserveFixedTraceDiagnosticOutput(path)).toThrow('Cannot exclusively reserve');
    expect(readFileSync(path, 'utf8')).toBe('existing');
  });

  it('rejects directory and missing-parent targets before dispatch', () => {
    const directory = mkdtempSync(join(tmpdir(), 'fixed-trace-output-'));
    expect(() => reserveFixedTraceDiagnosticOutput(directory)).toThrow('Cannot exclusively reserve');
    expect(() => reserveFixedTraceDiagnosticOutput(join(directory, 'missing', 'artifact.json'))).toThrow('Cannot exclusively reserve');
  });

  it('claims then finalizes through one exclusive descriptor', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'fixed-trace-output-')), 'artifact.json');
    const reservation = reserveFixedTraceDiagnosticOutput(path);
    reservation.finalize('{"diagnosticOnly":true}\n');
    expect(readFileSync(path, 'utf8')).toBe('{"diagnosticOnly":true}\n');
  });
});
