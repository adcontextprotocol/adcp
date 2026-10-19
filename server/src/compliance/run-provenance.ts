import { LIBRARY_VERSION } from '@adcp/sdk';
import type { ComplianceResult, ComplyOptions } from '@adcp/sdk/testing';

export interface ComplianceRunProvenance {
  grading_policy_version: string;
  compliance_bundle_version: string | null;
  /**
   * Declared specialisms the graded release does not define, which capability
   * resolution was allowed to skip instead of voiding the run (adcp#8269).
   * Present only on runs that used that allowance, so a stored audit record
   * states plainly that resolution saw more than the released index. The
   * bundle's own storyboards and grading are unchanged.
   */
  tolerated_undefined_specialisms?: string[];
  sdk_version: string;
  agent_build_version: string | null;
  agent_library_version: string | null;
  test_session_id: string | null;
  timeout_ms: number | null;
  storyboard_start_offset: number | null;
  auth_type: string | null;
}

export function complianceRunProvenance(
  result: Pick<ComplianceResult, 'adcp_version' | 'agent_profile'>,
  options?: ComplyOptions,
  toleratedUndefinedSpecialisms?: readonly string[],
): ComplianceRunProvenance {
  return {
    grading_policy_version: 'hosted-compliance-v1',
    compliance_bundle_version: result.adcp_version ?? null,
    ...(toleratedUndefinedSpecialisms?.length
      ? { tolerated_undefined_specialisms: [...toleratedUndefinedSpecialisms] }
      : {}),
    sdk_version: LIBRARY_VERSION,
    // Agent-reported provenance; absent optional fields remain unknown.
    agent_build_version: result.agent_profile?.adcp_build_version ?? null,
    agent_library_version: result.agent_profile?.library_version ?? null,
    test_session_id: options?.test_session_id ?? null,
    timeout_ms: options?.timeout_ms ?? null,
    storyboard_start_offset: options?.storyboard_start_offset ?? null,
    auth_type: options?.auth?.type ?? null,
  };
}
