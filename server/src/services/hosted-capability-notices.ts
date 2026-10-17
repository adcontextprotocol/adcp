import type { ErrorObject } from 'ajv';
import type { ComplianceResult } from '@adcp/sdk/testing';
import { withExternalSchemaRoot } from '@adcp/sdk/testing';
import { getCanonicalToolValidator } from '@adcp/sdk/schemas';
import {
  hostedComplianceTarget,
  hostedSchemaArtifactsExist,
  hostedStableLineAliasForTarget,
  type HostedComplianceTarget,
} from './hosted-compliance-version.js';

/**
 * Capability-schema notices for agents that serve a newer release than the
 * hosted target.
 *
 * A 3.0 pin sends only `adcp_major_version: 3`, so a conformant agent may
 * serve and echo its highest 3.x release. @adcp/sdk validates the
 * capabilities against that echo only when no external schema root is active
 * for the pin. Hosted compliance always runs with the target's hosted root, so
 * the SDK validates a 3.2 capabilities response against 3.0 and reports
 * `capabilities_response_schema_invalid` notices for fields 3.0 never had.
 *
 * This re-validates the agent's capabilities against the echoed release's
 * hosted schema root and replaces those notices. Notices are informational.
 * Storyboards, step validations, track status and badges still come from the
 * selected target.
 */

export const CAPABILITIES_SCHEMA_NOTICE_CODE = 'capabilities_response_schema_invalid';
// Same text and docs link the SDK runner uses (collectCapabilityNotices).
const CAPABILITIES_SCHEMA_NOTICE_DOCS = 'https://github.com/adcontextprotocol/adcp/issues/6254';

const RELEASE_MAJOR = /^([1-9][0-9]*)\.[0-9]+/;
const FULL_RELEASE = /^([1-9][0-9]*\.[0-9]+)\.[0-9]+((?:-(?:beta|rc)\.[0-9]+)?)$/;

export interface CapabilitySchemaIssue {
  pointer: string;
  message: string;
}

type RunnerNotice = ComplianceResult['notices'][number];
type CapabilityProfile = {
  raw_capabilities?: Record<string, unknown>;
  capabilities_schema_issues?: CapabilitySchemaIssue[];
};

/** Release-precision wire form of a bundled version: 3.0.27 -> 3.0, 3.2.0-rc.7 -> 3.2-rc.7. */
function releasePrecision(version: string): string | undefined {
  const match = FULL_RELEASE.exec(version);
  return match ? `${match[1]}${match[2]}` : undefined;
}

/**
 * The hosted target for the release an agent echoed, when the echo is in the
 * target's major, names a different release than the target, and that release
 * has hosted schema artifacts. Otherwise undefined: the SDK's own validation
 * already ran against the right release.
 */
export function hostedTargetForEchoedRelease(
  echoed: unknown,
  target: HostedComplianceTarget,
): HostedComplianceTarget | undefined {
  if (typeof echoed !== 'string') return undefined;
  const echoMajor = RELEASE_MAJOR.exec(echoed)?.[1];
  if (echoMajor === undefined || echoMajor !== RELEASE_MAJOR.exec(target.version)?.[1]) return undefined;
  if (echoed === releasePrecision(target.version) || echoed === hostedStableLineAliasForTarget(target)) {
    return undefined;
  }

  let served: HostedComplianceTarget;
  try {
    served = hostedComplianceTarget(echoed);
  } catch {
    return undefined;
  }
  if (served.version === target.version || !hostedSchemaArtifactsExist(served.version)) return undefined;
  return served;
}

// Mirrors the SDK's issue shape: required-property errors point at the
// missing property, and enum errors list the allowed values.
function toIssue(error: ErrorObject): CapabilitySchemaIssue {
  const missingProperty = error.keyword === 'required' && typeof error.params?.missingProperty === 'string'
    ? `/${error.params.missingProperty}`
    : '';
  const allowedValues = error.keyword === 'enum' && Array.isArray(error.params?.allowedValues)
    ? error.params.allowedValues as unknown[]
    : undefined;
  return {
    pointer: `${error.instancePath ?? ''}${missingProperty}` || '/',
    message: allowedValues
      ? `must be one of: ${allowedValues.map(value => JSON.stringify(value)).join(', ')}`
      : error.message ?? 'validation failed',
  };
}

/**
 * Validate a `get_adcp_capabilities` response against a hosted release's
 * schema root. Undefined when no validator is available for that release.
 */
export function capabilitySchemaIssuesForHostedRelease(
  capabilities: unknown,
  served: HostedComplianceTarget,
): CapabilitySchemaIssue[] | undefined {
  return withExternalSchemaRoot(served.version, served.schemaRoot, () => {
    const validate = getCanonicalToolValidator('get_adcp_capabilities', 'sync', { adcpVersion: served.version });
    if (!validate) return undefined;
    if (validate(capabilities)) return [];
    const byPointer = new Map<string, CapabilitySchemaIssue>();
    for (const error of validate.errors ?? []) {
      const issue = toIssue(error);
      if (!byPointer.has(issue.pointer)) byPointer.set(issue.pointer, issue);
    }
    return [...byPointer.values()];
  });
}

function capabilitySchemaNotice(issue: CapabilitySchemaIssue, storyboardIds: readonly string[]): RunnerNotice {
  return {
    severity: 'info',
    code: CAPABILITIES_SCHEMA_NOTICE_CODE,
    message: `The agent's get_adcp_capabilities response failed schema validation at ${issue.pointer}: ${issue.message}. Track results may share this root cause; fix it first, then re-read the failures.`,
    capability_pointer: issue.pointer,
    docs_url: CAPABILITIES_SCHEMA_NOTICE_DOCS,
    storyboard_ids: [...storyboardIds],
  } as RunnerNotice;
}

/**
 * Replace the run's capability-schema notices with ones validated against the
 * release the agent echoed, when that differs from the hosted target. Every
 * other notice and every graded field is left as the SDK produced it.
 */
export function reconcileCapabilityNoticesWithEchoedRelease<T extends ComplianceResult>(
  result: T,
  target: HostedComplianceTarget,
): T {
  const profile = result.agent_profile as (ComplianceResult['agent_profile'] & CapabilityProfile) | undefined;
  const capabilities = profile?.raw_capabilities;
  const served = hostedTargetForEchoedRelease(capabilities?.adcp_version, target);
  if (!profile || !served) return result;

  let issues: CapabilitySchemaIssue[] | undefined;
  try {
    issues = capabilitySchemaIssuesForHostedRelease(capabilities, served);
  } catch {
    // Notices are informational. If the echoed bundle cannot be loaded, keep
    // the SDK's result rather than fail the run.
    return result;
  }
  if (!issues) return result;

  const notices = result.notices ?? [];
  const stale = notices.filter(notice => notice.code === CAPABILITIES_SCHEMA_NOTICE_CODE);
  // The SDK attaches capability notices to every storyboard that ran with the
  // profile. Keep that set; if the pinned validation found nothing, use the
  // storyboards this run executed.
  const storyboardIds = stale.length > 0
    ? [...new Set(stale.flatMap(notice => notice.storyboard_ids ?? []))]
    : [...(result.storyboards_executed ?? [])];

  const agentProfile = { ...profile };
  if (issues.length > 0) agentProfile.capabilities_schema_issues = issues;
  else delete agentProfile.capabilities_schema_issues;
  return {
    ...result,
    agent_profile: agentProfile,
    notices: [
      ...issues.map(issue => capabilitySchemaNotice(issue, storyboardIds)),
      ...notices.filter(notice => notice.code !== CAPABILITIES_SCHEMA_NOTICE_CODE),
    ],
  };
}
