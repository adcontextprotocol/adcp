import { describe, expect, it } from 'vitest';
import type { ComplianceResult } from '@adcp/sdk/testing';
import {
  CAPABILITIES_SCHEMA_NOTICE_CODE,
  hostedTargetForEchoedRelease,
  reconcileCapabilityNoticesWithEchoedRelease,
} from '../../src/services/hosted-capability-notices.js';
import { hostedComplianceTarget } from '../../src/services/hosted-compliance-version.js';

// A 3.2 capabilities response that 3.0 rejects only because 3.0 closes the
// compliance_testing.scenarios enum to six values.
const THREE_TWO_CAPABILITIES = {
  adcp_version: '3.2',
  status: 'completed',
  adcp: { major_versions: [3], supported_versions: ['3.0', '3.2'], idempotency: { supported: false } },
  supported_protocols: ['signals'],
  compliance_testing: { scenarios: ['force_session_status', 'seed_product'] },
};

function staleNotice(pointer: string) {
  return {
    severity: 'info',
    code: CAPABILITIES_SCHEMA_NOTICE_CODE,
    message: `The agent's get_adcp_capabilities response failed schema validation at ${pointer}: must be one of: ...`,
    capability_pointer: pointer,
    docs_url: 'https://github.com/adcontextprotocol/adcp/issues/6254',
    storyboard_ids: ['capability_discovery', 'schema_validation'],
  };
}

const deprecationNotice = {
  severity: 'deprecation',
  code: 'signed_requests_specialism_deprecated',
  message: 'deprecated',
  storyboard_ids: ['signed_requests'],
};

function resultWith(capabilities: Record<string, unknown>, notices: unknown[]): ComplianceResult {
  return {
    agent_profile: {
      name: 'agent',
      tools: ['get_adcp_capabilities'],
      raw_capabilities: capabilities,
      capabilities_schema_issues: [{ pointer: '/compliance_testing/scenarios/1', message: 'must be one of: ...' }],
    },
    storyboards_executed: ['capability_discovery', 'schema_validation'],
    notices,
  } as unknown as ComplianceResult;
}

describe('hostedTargetForEchoedRelease', () => {
  const threeZero = hostedComplianceTarget('3.0');
  const threeTwo = hostedComplianceTarget('3.2');

  it('returns the hosted bundle for a newer same-major echo', () => {
    expect(hostedTargetForEchoedRelease('3.2', threeZero)?.version).toBe(threeTwo.version);
  });

  it.each([
    ['the target release itself', '3.0'],
    ['a different major', '4.0'],
    ['a release with no hosted bundle', '3.9'],
    ['a non-string echo', 3],
    ['no echo', undefined],
  ])('returns undefined for %s', (_label, echoed) => {
    expect(hostedTargetForEchoedRelease(echoed, threeZero)).toBeUndefined();
  });

  it('returns undefined when a 3.2 target sees a 3.2 echo', () => {
    expect(hostedTargetForEchoedRelease('3.2', threeTwo)).toBeUndefined();
  });
});

describe('reconcileCapabilityNoticesWithEchoedRelease', () => {
  const threeZero = hostedComplianceTarget('3.0');

  it('drops 3.0 schema notices for capabilities that are valid in the echoed 3.2 release', () => {
    const result = resultWith(THREE_TWO_CAPABILITIES, [
      staleNotice('/compliance_testing/scenarios/1'),
      deprecationNotice,
    ]);
    const reconciled = reconcileCapabilityNoticesWithEchoedRelease(result, threeZero);

    expect(reconciled.notices).toEqual([deprecationNotice]);
    expect((reconciled.agent_profile as { capabilities_schema_issues?: unknown }).capabilities_schema_issues)
      .toBeUndefined();
    // Nothing graded changes.
    expect(reconciled.storyboards_executed).toBe(result.storyboards_executed);
  });

  it('reports what the echoed release itself rejects, on the same storyboards', () => {
    const invalid = {
      ...THREE_TWO_CAPABILITIES,
      adcp: { major_versions: [3], supported_versions: ['3.0', '3.2'] },
    };
    const reconciled = reconcileCapabilityNoticesWithEchoedRelease(
      resultWith(invalid, [staleNotice('/compliance_testing/scenarios/1')]),
      threeZero,
    );

    const capabilityNotices = reconciled.notices.filter(n => n.code === CAPABILITIES_SCHEMA_NOTICE_CODE);
    expect(capabilityNotices.map(n => n.capability_pointer)).toEqual(['/adcp/idempotency']);
    expect(capabilityNotices[0]).toMatchObject({
      severity: 'info',
      message: expect.stringContaining('failed schema validation at /adcp/idempotency'),
      storyboard_ids: ['capability_discovery', 'schema_validation'],
    });
  });

  it('leaves the result alone when the echo is the target release', () => {
    const result = resultWith({ ...THREE_TWO_CAPABILITIES, adcp_version: '3.0' }, [
      staleNotice('/compliance_testing/scenarios/1'),
    ]);
    expect(reconcileCapabilityNoticesWithEchoedRelease(result, threeZero)).toBe(result);
  });
});
