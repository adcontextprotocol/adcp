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
  SUPPORTED_BADGE_VERSIONS: ['3.0'],
  isStableSpecialism: vi.fn(() => true),
}));

import { complianceResultToDbInput } from '../../src/addie/services/compliance-testing.js';

function baseResult(options: {
  notices?: unknown[];
  summaryNotices?: unknown[];
} = {}) {
  const summary = {
    headline: 'All checks passed',
    tracks_passed: 1,
    tracks_failed: 0,
    tracks_partial: 0,
    tracks_skipped: 0,
    ...(options.summaryNotices !== undefined && { notices: options.summaryNotices }),
  };
  return {
    overall_status: 'passing',
    tracks: [],
    summary,
    ...(options.notices !== undefined && { notices: options.notices }),
    total_duration_ms: 1234,
    agent_profile: { name: 'test-agent', tools: [] },
    observations: [],
  };
}

describe('complianceResultToDbInput — notices pass-through', () => {
  it('maps current top-level notices and preserves every field verbatim', () => {
    const notice = {
      severity: 'supersedes_future_requirement',
      code: 'some_new_code_from_future_runner',
      message: 'Advisory from a future runner version.',
      effective_version: '4.0',
      capability_path: 'account.supported_billing',
      capability_pointer: '/account/supported_billing/0',
      docs_url: 'https://example.com/adcp/migration',
      storyboard_ids: ['media_buy_seller', 'media_buy_planning'],
      experimental_context: {
        remediation: 'rename the billing enum',
        priority: 2,
      },
    };
    const result = baseResult({
      notices: [notice],
      summaryNotices: [{
        severity: 'deprecation',
        code: 'stale_legacy_notice',
        message: 'Top-level notices take precedence over this legacy value.',
      }],
    });

    const dbInput = complianceResultToDbInput(
      result as any,
      'https://example.com/agent',
      'production',
      'heartbeat',
    );

    expect(dbInput.notices_json).toEqual([notice]);
  });

  it('uses an explicit empty top-level array instead of legacy summary notices', () => {
    const result = baseResult({
      notices: [],
      summaryNotices: [{
        severity: 'deprecation',
        code: 'stale_legacy_notice',
        message: 'This legacy notice must not survive a clean current result.',
      }],
    });

    const dbInput = complianceResultToDbInput(
      result as any,
      'https://example.com/agent',
      'production',
    );

    expect(dbInput.notices_json).toEqual([]);
  });

  it('falls back to legacy summary notices when the top-level field is absent', () => {
    const legacyNotice = {
      severity: 'deprecation',
      code: 'signed_requests_specialism_deprecated',
      message: 'Agent advertises the deprecated `signed-requests` specialism enum value.',
      capability_path: 'specialisms',
      reference_url: 'https://github.com/adcontextprotocol/adcp/issues/3078',
      legacy_extra: 'preserved',
    };
    const result = baseResult({ summaryNotices: [legacyNotice] });

    const dbInput = complianceResultToDbInput(
      result as any,
      'https://example.com/agent',
      'production',
    );

    expect(dbInput.notices_json).toEqual([legacyNotice]);
  });

  it('sets notices_json to null when neither result shape has notices', () => {
    const result = baseResult();

    const dbInput = complianceResultToDbInput(
      result as any,
      'https://example.com/agent',
      'production',
    );

    expect(dbInput.notices_json).toBeNull();
  });
});
