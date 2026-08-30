import { describe, expect, it } from 'vitest';
import {
  FAILED_LOOKUP_EVIDENCE_RESPONSE,
  enforceFailedLookupEvidenceBoundary,
} from '../../../src/addie/failed-lookup-evidence.js';
import type { ToolExecution } from '../../../src/addie/model-providers/tool-orchestration.js';

function execution(toolName: string, isError: boolean): ToolExecution {
  return {
    tool_name: toolName,
    parameters: {},
    result: isError ? 'Error: source unavailable' : 'Verified source result',
    is_error: isError,
    duration_ms: 1,
    sequence: 1,
  };
}

describe('failed lookup evidence boundary', () => {
  it('replaces unsupported prose and links when every source lookup failed', () => {
    const result = enforceFailedLookupEvidenceBoundary(
      'The docs confirm this. See https://invented.example/docs.',
      [execution('search_docs', true), { ...execution('get_doc', true), sequence: 2 }],
    );

    expect(result).toEqual({
      text: FAILED_LOOKUP_EVIDENCE_RESPONSE,
      enforced: true,
      reason: 'Failed lookup evidence boundary enforced (get_doc, search_docs)',
      failedToolNames: ['get_doc', 'search_docs'],
    });
    expect(result.text).not.toContain('invented.example');
  });

  it('retains a response when any source lookup succeeded', () => {
    const text = 'The successful source supports this answer.';
    const result = enforceFailedLookupEvidenceBoundary(
      text,
      [execution('search_docs', true), { ...execution('web_search', false), sequence: 2 }],
    );

    expect(result).toMatchObject({ text, enforced: false, reason: null });
  });

  it('does not replace a response when a non-lookup operation also ran', () => {
    const text = 'The lookup failed, but the requested invoice was sent.';
    const result = enforceFailedLookupEvidenceBoundary(
      text,
      [execution('search_docs', true), { ...execution('send_invoice', false), sequence: 2 }],
    );

    expect(result).toMatchObject({ text, enforced: false, reason: null });
  });

  it('does not classify a failed action as a failed source lookup', () => {
    const text = 'The invoice could not be sent.';
    const result = enforceFailedLookupEvidenceBoundary(text, [execution('send_invoice', true)]);

    expect(result).toMatchObject({ text, enforced: false, reason: null });
  });

  it('does not classify local validation as a source lookup', () => {
    const text = 'The submitted JSON is invalid.';
    const result = enforceFailedLookupEvidenceBoundary(text, [execution('validate_json', true)]);

    expect(result).toMatchObject({ text, enforced: false, reason: null });
  });
});
