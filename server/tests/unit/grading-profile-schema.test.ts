import { describe, expect, it } from 'vitest';
import {
  AgentComplianceDetailSchema,
  GradingProfileComparisonSchema,
} from '../../src/schemas/registry.js';

const exactComparison = {
  scope: 'badge' as const,
  role: 'media-buy' as const,
  adcp_version: '3.1',
  availability: 'current' as const,
  unavailable_reason: null,
  selected_profile: 'spec' as const,
  selection_enabled: true,
  selection_revision: 2,
  source_run_id: '11111111-1111-4111-8111-111111111111',
  evaluator_policy_version: 'verification-profiles-role-v1',
  compliance_bundle_version: '3.1.4',
  profiles: {
    legacy: { available: true, status: 'passing' as const, observed_status: 'passing' as const, explanation: 'Passes.', public_effect: 'regrade' as const, grace_deadline: null },
    spec: { available: true, status: 'failing' as const, observed_status: 'failing' as const, explanation: 'Fails.', public_effect: 'degrade' as const, grace_deadline: '2026-09-18T10:00:00.000Z' },
    sandbox: { available: false, status: null, observed_status: null, explanation: 'Preview only.', public_effect: 'unchanged' as const, grace_deadline: null },
  },
  evidence: {
    specialisms: ['sales-non-guaranteed'],
    relevant_bundle_count: 3,
    relevant_bundle_ids: ['universal:universal', 'protocol:media-buy', 'specialism:sales-non-guaranteed'],
    failing_bundle_count: 1,
    incomplete_bundle_count: 0,
    relevant_failure_count: 1,
    missing_universal_bundle: false,
    missing_protocol_bundle: false,
    missing_specialism_bundles: [],
    evaluator: 'legacy-specialism-parity',
  },
};

describe('grading profile API schemas', () => {
  it('accepts exact badge evidence and its server-calculated public impact', () => {
    expect(GradingProfileComparisonSchema.parse(exactComparison)).toMatchObject({
      scope: 'badge',
      role: 'media-buy',
      profiles: { spec: { public_effect: 'degrade' } },
    });
  });

  it('requires exact badge identity for badge-scope comparisons', () => {
    const { role: _role, ...withoutRole } = exactComparison;
    expect(GradingProfileComparisonSchema.safeParse(withoutRole).success).toBe(false);
  });

  it('exposes explicit selected role/version status independently of the agent summary', () => {
    const parsed = AgentComplianceDetailSchema.parse({
      agent_url: 'https://seller.example.test/mcp',
      status: 'passing',
      lifecycle_stage: 'production',
      selected_grading_statuses: [{
        role: 'media-buy', adcp_version: '3.1', grading_profile: 'spec',
        grading_status: 'failing', availability: 'current', badge_status: 'revoked', revision: '2',
      }],
      grading_profile_comparisons: [exactComparison],
    });
    expect(parsed.selected_grading_statuses?.[0]).toMatchObject({
      grading_profile: 'spec', grading_status: 'failing', badge_status: 'revoked',
    });
  });
});
