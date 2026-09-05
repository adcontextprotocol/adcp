import type { AddieTool } from '../types.js';
import { FIXED_TRACE_DIRECT_TOOL_UNIVERSE } from '../direct-tool-universe.js';
import type { FixedTraceCase } from './fixed-trace-suite.js';

/**
 * Architecture is a cohort boundary, not a tunable label.  In particular, an
 * oracle route is useful for diagnosing generation quality but is never
 * rollout evidence.
 */
export const FIXED_TRACE_ARCHITECTURE_ARMS = Object.freeze({
  two_stage_llm_router: Object.freeze({
    id: 'two_stage_llm_router',
    routeSource: 'llm_router',
    // Architectural capability is distinct from authenticated evaluation
    // evidence; this foundation is diagnostic-only.
    rolloutEligible: false,
  }),
  direct_generation: Object.freeze({
    id: 'direct_generation',
    routeSource: 'deployable_surface_policy',
    rolloutEligible: false,
  }),
  oracle_route_diagnostic: Object.freeze({
    id: 'oracle_route_diagnostic',
    routeSource: 'fixture_oracle',
    rolloutEligible: false,
  }),
} as const);

export type FixedTraceArchitectureArmId = keyof typeof FIXED_TRACE_ARCHITECTURE_ARMS;
export type FixedTraceArchitectureArmProvenance =
  (typeof FIXED_TRACE_ARCHITECTURE_ARMS)[FixedTraceArchitectureArmId];

export function fixedTraceArchitectureArm(
  arm: FixedTraceArchitectureArmId = 'two_stage_llm_router',
): FixedTraceArchitectureArmProvenance {
  return FIXED_TRACE_ARCHITECTURE_ARMS[arm];
}

export type FixedTraceToolDefinitionProvenance =
  | 'fixture_local'
  | 'authorized_definition_handler_intersection';

/**
 * Records what selected the candidate's visible tools.  The production
 * definition/handler intersection is authorization-aware, but it is currently
 * wider than the bounded routed surface and is not exposed by this evaluator.
 */
export interface FixedTraceToolUniverseProvenance {
  source:
    | 'fixture_local_routed_replay'
    | 'authorized_definition_handler_intersection_not_captured'
    | 'evaluator_owned_production_shaped_intersection'
    | 'fixture_oracle';
  intentNarrowing: 'llm_router' | 'not_applied' | 'fixture_oracle';
  bounded: boolean;
  deployable: boolean;
  toolNames: readonly string[] | null;
  toolNamesSha256?: string | null;
  toolSchemaSha256?: string | null;
  definitionHandlerSha256?: string | null;
}

/**
 * The fixed loop's mutation policy is fixture-derived today. A deployable
 * direct arm needs a shared request/thread-fact execution envelope before it
 * can reuse the production-equivalent executor.
 */
export interface FixedTraceExecutionEnvelopeProvenance {
  source: 'fixture_expectation' | 'request_thread_facts_not_captured' | 'evaluator_owned_shared_request_thread_envelope' | 'fixture_oracle';
  deployable: boolean;
}

export function fixedTraceExecutionEnvelopeProvenance(
  arm: FixedTraceArchitectureArmId = 'two_stage_llm_router',
): FixedTraceExecutionEnvelopeProvenance {
  if (arm === 'direct_generation') return Object.freeze({
    source: 'evaluator_owned_shared_request_thread_envelope',
    deployable: false,
  });
  if (arm === 'oracle_route_diagnostic') return Object.freeze({
    source: 'fixture_oracle',
    deployable: false,
  });
  return Object.freeze({ source: 'fixture_expectation', deployable: false });
}

export function fixedTraceToolUniverseProvenance(
  arm: FixedTraceArchitectureArmId = 'two_stage_llm_router',
): FixedTraceToolUniverseProvenance {
  if (arm === 'direct_generation') {
    return Object.freeze({
      source: 'evaluator_owned_production_shaped_intersection',
      intentNarrowing: 'not_applied',
      bounded: true,
      deployable: false,
      toolNames: FIXED_TRACE_DIRECT_TOOL_UNIVERSE.toolNames,
      toolNamesSha256: FIXED_TRACE_DIRECT_TOOL_UNIVERSE.toolNamesSha256,
      toolSchemaSha256: FIXED_TRACE_DIRECT_TOOL_UNIVERSE.toolSchemaSha256,
      definitionHandlerSha256: FIXED_TRACE_DIRECT_TOOL_UNIVERSE.definitionHandlerSha256,
    });
  }
  if (arm === 'oracle_route_diagnostic') {
    return Object.freeze({
      source: 'fixture_oracle',
      intentNarrowing: 'fixture_oracle',
      bounded: true,
      deployable: false,
      toolNames: null,
    });
  }
  return Object.freeze({
    source: 'fixture_local_routed_replay',
    intentNarrowing: 'llm_router',
    bounded: true,
    deployable: false,
    toolNames: null,
  });
}

export type FixedTraceDirectArmAdmissionReason =
  | 'fixture_local_tool_definitions'
  | 'authorized_tool_intersection_not_captured'
  | 'authorized_tool_universe_unbounded'
  | 'request_thread_execution_envelope_not_captured';

export interface FixedTraceDirectToolUniverse extends FixedTraceToolUniverseProvenance {
  surface: FixedTraceCase['request']['source'];
  isAdmin: boolean;
}

export interface FixedTraceDirectArmAdmission {
  admitted: boolean;
  reasons: readonly FixedTraceDirectArmAdmissionReason[];
  universe: FixedTraceDirectToolUniverse;
}

function freezeAdmission(
  admitted: boolean,
  reasons: FixedTraceDirectArmAdmissionReason[],
  universe: FixedTraceDirectToolUniverse,
): FixedTraceDirectArmAdmission {
  return Object.freeze({
    admitted,
    reasons: Object.freeze([...reasons]),
    universe: Object.freeze({
      ...universe,
      toolNames: universe.toolNames === null ? null : Object.freeze([...universe.toolNames]),
    }),
  });
}

/**
 * Identify the production pre-intent universe using only request facts. This
 * deliberately does not inspect trace routing, expectations, fixtures, or
 * grades. The evaluator cannot yet capture the authenticated definition /
 * handler intersection, and must not substitute a fixture-local subset.
 */
export function deriveFixedTraceDirectToolUniverse(trace: FixedTraceCase): FixedTraceDirectToolUniverse {
  return Object.freeze({
    ...fixedTraceToolUniverseProvenance('direct_generation'),
    // Surface and authorization are evaluator-owned. Fixed traces can supply
    // only synthetic conversation content, never capability claims.
    surface: 'dm',
    isAdmin: false,
  });
}

/**
 * Admit a direct arm only when its independently-derived production surface
 * can be replayed exactly. `fixture_local` is intentionally never accepted:
 * it was selected from expected trace tools and would leak the answer through
 * the candidate's schemas. A future direct arm must first expose a bounded,
 * request-fact-derived definition/handler intersection plus synthetic results
 * for every visible custom tool.
 */
export function admitFixedTraceDirectArm(
  trace: FixedTraceCase,
  definitions: readonly AddieTool[],
  definitionProvenance: FixedTraceToolDefinitionProvenance,
): FixedTraceDirectArmAdmission {
  const universe = deriveFixedTraceDirectToolUniverse(trace);
  // The evaluator's definitions, synthetic receipt handlers, policy, and
  // request/thread envelope are all fixed above. Caller-provided definitions
  // and provenance never participate in direct admission.
  void definitions;
  void definitionProvenance;
  return freezeAdmission(true, [], universe);
}
