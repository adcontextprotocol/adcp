import { describe, expect, it } from 'vitest';
import {
  formatFailureDetailSnippet,
  formatFailedValidationSummary,
  formatStepFailureDetail,
} from '../manual/storyboard-report-format.js';

describe('manual storyboard report formatting', () => {
  it('includes validation ids in failed-validation summaries', () => {
    const out = formatFailedValidationSummary([
      {
        id: 'multi_finalize_unsupported.error_code',
        passed: false,
        description: 'Multi-finalize rejected with MULTI_FINALIZE_UNSUPPORTED or INVALID_REQUEST',
        error: 'Expected one of MULTI_FINALIZE_UNSUPPORTED, INVALID_REQUEST; got INTERNAL_ERROR',
      },
    ]);

    expect(out).toContain('multi_finalize_unsupported.error_code');
    expect(out).toContain('Multi-finalize rejected with MULTI_FINALIZE_UNSUPPORTED or INVALID_REQUEST');
    expect(out).toContain('INTERNAL_ERROR');
  });

  it('can include actual values when the summary caller requests them', () => {
    const out = formatFailedValidationSummary([
      {
        id: 'multi_finalize_gate.any_path_contributed',
        passed: false,
        description: 'Seller either handled multi-finalize atomically or rejected with MULTI_FINALIZE_UNSUPPORTED',
        actual: ['mixed_finalize_rejected'],
      },
    ], { includeActual: true });

    expect(out).toContain('multi_finalize_gate.any_path_contributed');
    expect(out).toContain('["mixed_finalize_rejected"]');
  });

  it('keeps validation ids when a step-level error is present', () => {
    const out = formatStepFailureDetail('Probe validations failed.', [
      {
        id: 'multi_finalize_unsupported.error_code',
        passed: false,
        description: 'Multi-finalize rejected with MULTI_FINALIZE_UNSUPPORTED or INVALID_REQUEST',
      },
    ]);

    expect(out).toContain('Probe validations failed.');
    expect(out).toContain('multi_finalize_unsupported.error_code');
  });

  it('preserves the first failed validation id when non-verbose output is truncated', () => {
    const out = formatFailureDetailSnippet(
      `${'x'.repeat(200)} — multi_finalize_unsupported.error_code: wrong code`,
      {
        maxLength: 40,
        validationId: 'multi_finalize_unsupported.error_code',
      },
    );

    expect(out.startsWith('multi_finalize_unsupported.error_code:')).toBe(true);
  });
});
