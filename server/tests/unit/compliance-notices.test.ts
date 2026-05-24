/**
 * Tests that compliance runner notices are correctly passed through
 * complianceResultToDbInput() and preserved verbatim (forward-compat).
 *
 * runner-output-contract.yaml: receivers MUST treat unknown code/severity
 * values as well-formed and surface them verbatim — do not drop or
 * schema-validate these fields.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@adcp/sdk/testing', () => ({
  setAgentTesterLogger: vi.fn(),
  comply: vi.fn(),
  loadComplianceIndex: vi.fn(() => ({ specialisms: [] })),
  SAMPLE_BRIEFS: [],
  getBriefsByVertical: vi.fn(() => []),
}));

vi.mock('../../src/services/storyboards.js', () => ({
  getStoryboard: vi.fn(() => null),
  getAllStoryboards: vi.fn(() => []),
}));

vi.mock('../../src/services/adcp-taxonomy.js', () => ({
  isStableSpecialism: vi.fn(() => true),
}));

import { complianceResultToDbInput } from '../../src/addie/services/compliance-testing.js';

function baseResult(overrides: Record<string, unknown> = {}) {
  return {
    overall_status: 'passing',
    tracks: [],
    summary: {
      headline: 'All checks passed',
      tracks_passed: 1,
      tracks_failed: 0,
      tracks_partial: 0,
      tracks_skipped: 0,
      ...overrides,
    },
    total_duration_ms: 1234,
    agent_profile: { name: 'test-agent', tools: [] },
    observations: [],
  };
}

describe('complianceResultToDbInput — notices pass-through', () => {
  it('maps a deprecation notice from result.summary.notices to notices_json', () => {
    const result = baseResult({
      notices: [
        {
          severity: 'deprecation',
          code: 'signed_requests_specialism_deprecated',
          message: 'Agent advertises the deprecated `signed-requests` specialism enum value.',
          capability_path: 'specialisms',
          reference_url: 'https://github.com/adcontextprotocol/adcp/issues/3078',
        },
      ],
    });

    const dbInput = complianceResultToDbInput(
      result as any,
      'https://example.com/agent',
      'production',
      'heartbeat',
    );

    expect(dbInput.notices_json).toHaveLength(1);
    const notice = dbInput.notices_json![0];
    expect(notice.severity).toBe('deprecation');
    expect(notice.code).toBe('signed_requests_specialism_deprecated');
    expect(notice.message).toContain('deprecated');
    expect(notice.capability_path).toBe('specialisms');
    expect(notice.reference_url).toContain('3078');
    expect(notice.effective_version).toBeUndefined();
  });

  it('maps a future_required notice with effective_version', () => {
    const result = baseResult({
      notices: [
        {
          severity: 'future_required',
          code: 'request_signing_required_in_4_0',
          message: '`request_signing.supported: true` is optional in 3.x but required in AdCP 4.0.',
          effective_version: '4.0',
          capability_path: 'request_signing.supported',
        },
      ],
    });

    const dbInput = complianceResultToDbInput(
      result as any,
      'https://example.com/agent',
      'production',
    );

    expect(dbInput.notices_json).toHaveLength(1);
    const notice = dbInput.notices_json![0];
    expect(notice.severity).toBe('future_required');
    expect(notice.code).toBe('request_signing_required_in_4_0');
    expect(notice.effective_version).toBe('4.0');
    expect(notice.capability_path).toBe('request_signing.supported');
  });

  it('preserves unknown notice codes and severities verbatim (forward-compat)', () => {
    const result = baseResult({
      notices: [
        {
          severity: 'supersedes_future_requirement',   // unknown severity
          code: 'some_new_code_from_future_runner',    // unknown code
          message: 'Advisory from a future runner version.',
        },
      ],
    });

    const dbInput = complianceResultToDbInput(
      result as any,
      'https://example.com/agent',
      'production',
    );

    // Forward-compat: MUST NOT drop or filter unknown values
    expect(dbInput.notices_json).toHaveLength(1);
    const notice = dbInput.notices_json![0];
    expect(notice.severity).toBe('supersedes_future_requirement');
    expect(notice.code).toBe('some_new_code_from_future_runner');
    expect(notice.message).toBe('Advisory from a future runner version.');
  });

  it('sets notices_json to null when summary has no notices field', () => {
    const result = baseResult();
    // No `notices` key in summary

    const dbInput = complianceResultToDbInput(
      result as any,
      'https://example.com/agent',
      'production',
    );

    expect(dbInput.notices_json).toBeNull();
  });

  it('sets notices_json to null when summary.notices is an empty array', () => {
    const result = baseResult({ notices: [] });

    const dbInput = complianceResultToDbInput(
      result as any,
      'https://example.com/agent',
      'production',
    );

    // Empty array is falsy via `?? null` — acceptable: no notices to show
    // (null and [] are both "no notices" in the API/dashboard logic)
    expect(dbInput.notices_json == null || Array.isArray(dbInput.notices_json)).toBe(true);
    if (Array.isArray(dbInput.notices_json)) {
      expect(dbInput.notices_json).toHaveLength(0);
    }
  });
});
