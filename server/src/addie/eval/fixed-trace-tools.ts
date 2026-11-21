import { ADMIN_TOOLS } from '../mcp/admin-tool-definitions.js';
import { BILLING_TOOLS } from '../mcp/billing-tool-definitions.js';
import { BRAND_CANONICAL_TOOLS } from '../mcp/brand-canonical-tool-definitions.js';
import { COMMITTEE_LEADER_TOOLS } from '../mcp/committee-leader-tool-definitions.js';
import { DIRECTORY_TOOLS } from '../mcp/directory-tool-definitions.js';
import { ILLUSTRATION_TOOLS } from '../mcp/illustration-tool-definitions.js';
import { KNOWLEDGE_TOOLS } from '../mcp/knowledge-search-tool-definitions.js';
import { MEETING_TOOLS } from '../mcp/meeting-tool-definitions.js';
import { MEMBER_TOOLS } from '../mcp/member-tool-definitions.js';
import { PROPERTY_TOOLS } from '../mcp/property-tool-definitions.js';
import { SI_HOST_TOOLS } from '../mcp/si-host-tool-definitions.js';
import { CERTIFICATION_TOOLS } from '../mcp/certification-tool-definitions.js';
import type { AddieTool } from '../types.js';
import { FIXED_TRACE_SUITE, type FixedTraceCase } from './fixed-trace-suite.js';

const FIXED_TRACE_TOOL_SOURCES: readonly (readonly AddieTool[])[] = [
  KNOWLEDGE_TOOLS,
  MEMBER_TOOLS,
  ADMIN_TOOLS,
  BILLING_TOOLS,
  MEETING_TOOLS,
  BRAND_CANONICAL_TOOLS,
  COMMITTEE_LEADER_TOOLS,
  DIRECTORY_TOOLS,
  ILLUSTRATION_TOOLS,
  PROPERTY_TOOLS,
  SI_HOST_TOOLS,
  CERTIFICATION_TOOLS,
];

/**
 * Stable broad manifest for evaluator-only direct-tool discovery studies.
 * It intentionally exposes every corpus-relevant registered definition to
 * the model, rather than selecting definitions from an oracle route.
 */
export function allFixedTraceToolDefinitions(): AddieTool[] {
  const definitions = new Map<string, AddieTool>();
  for (const source of FIXED_TRACE_TOOL_SOURCES) {
    for (const definition of source) {
      const prior = definitions.get(definition.name);
      if (prior && JSON.stringify(prior) !== JSON.stringify(definition)) {
        throw new Error(`Conflicting fixed-trace tool definition: ${definition.name}`);
      }
      if (!prior) definitions.set(definition.name, definition);
    }
  }
  return [...definitions.values()];
}

/**
 * Resolve the exact canonical definitions needed by the fixed suite.
 *
 * Fixture names are derived from the suite instead of repeated in the live
 * runner. A new fixture therefore fails this preflight with its missing
 * definition before any provider dispatch can consume budget.
 */
export function canonicalFixedTraceToolDefinitions(
  traces: readonly FixedTraceCase[] = FIXED_TRACE_SUITE,
): AddieTool[] {
  const fixtureNames = [
    ...new Set(traces.flatMap((trace) => trace.toolFixtures.map((fixture) => fixture.name))),
  ];
  const required = new Set(fixtureNames);
  const definitions = new Map<string, AddieTool>();

  for (const source of FIXED_TRACE_TOOL_SOURCES) {
    for (const definition of source) {
      if (!required.has(definition.name)) continue;
      if (definitions.has(definition.name)) {
        throw new Error(`Duplicate fixed-trace tool definition: ${definition.name}`);
      }
      definitions.set(definition.name, definition);
    }
  }

  const missing = fixtureNames.filter((name) => !definitions.has(name));
  if (missing.length > 0) {
    throw new Error(`Missing fixed-trace tool definitions: ${missing.join(', ')}`);
  }
  return fixtureNames.map((name) => definitions.get(name)!);
}
