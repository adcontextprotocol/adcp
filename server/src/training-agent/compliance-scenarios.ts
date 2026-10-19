import { getToolResponseSchema } from '@adcp/sdk/schemas';

/**
 * `compliance_testing.scenarios` is a closed enum in some releases (3.0 lists
 * six scenarios) and an open string list in later ones. The closed set is
 * read from the served release's own `get_adcp_capabilities` response schema,
 * so capability discovery follows the bundle instead of a second hand-kept
 * list, and a scenario added after a release is never advertised to a caller
 * served that release.
 */

interface ScenarioItemsSchema {
  properties?: {
    compliance_testing?: {
      properties?: {
        scenarios?: { items?: { enum?: unknown } };
      };
    };
  };
}

const closedScenarioSets = new Map<string, ReadonlySet<string> | null>();

/**
 * The scenarios the served release's capabilities schema allows, or null when
 * that release accepts any scenario name (or its bundle cannot be loaded).
 */
export function closedComplianceScenarioSet(servedVersion: string): ReadonlySet<string> | null {
  const cached = closedScenarioSets.get(servedVersion);
  if (cached !== undefined) return cached;
  let document;
  try {
    document = getToolResponseSchema('get_adcp_capabilities', { adcpVersion: servedVersion });
  } catch {
    // A prerelease bundle may not be registered yet. Those releases accept
    // any scenario name, so leave the list as is and retry on the next call.
    return null;
  }
  const values = (document?.schema as ScenarioItemsSchema | undefined)
    ?.properties?.compliance_testing?.properties?.scenarios?.items?.enum;
  const allowed = Array.isArray(values)
    ? new Set(values.filter((value): value is string => typeof value === 'string'))
    : null;
  closedScenarioSets.set(servedVersion, allowed);
  return allowed;
}

/** Drop scenarios the served release's capabilities schema does not allow. */
export function complianceScenariosForServedVersion(
  scenarios: readonly string[],
  servedVersion: string,
): string[] {
  const allowed = closedComplianceScenarioSet(servedVersion);
  return allowed ? scenarios.filter(scenario => allowed.has(scenario)) : [...scenarios];
}
