import type { AddieTool } from '../types.js';
import { quickMatchRoutingContext, type ExecutionPlan } from '../router.js';
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
    diagnosticOnly: true,
  }),
  direct_generation: Object.freeze({
    id: 'direct_generation',
    routeSource: 'deployable_surface_policy',
    rolloutEligible: false,
    diagnosticOnly: true,
  }),
  deterministic_policy_llm_fallback_hybrid: Object.freeze({
    id: 'deterministic_policy_llm_fallback_hybrid',
    routeSource: 'production_quick_match_with_llm_fallback',
    rolloutEligible: false,
    diagnosticOnly: true,
  }),
  oracle_route_diagnostic: Object.freeze({
    id: 'oracle_route_diagnostic',
    routeSource: 'fixture_oracle',
    rolloutEligible: false,
    diagnosticOnly: true,
  }),
} as const);

export type FixedTraceArchitectureArmId = keyof typeof FIXED_TRACE_ARCHITECTURE_ARMS;
export type FixedTraceArchitectureArmProvenance =
  (typeof FIXED_TRACE_ARCHITECTURE_ARMS)[FixedTraceArchitectureArmId];

/**
 * The diagnostic hybrid is intentionally a strict subset of production's
 * quick-match policy.  It can only terminate no-tool surface outcomes; every
 * routed/tool-bearing decision retains the incumbent strict LLM router.
 */
export const FIXED_TRACE_HYBRID_POLICY_VERSION = 'fixed-trace-hybrid-quick-match-v1';

export interface FixedTraceHybridPolicy {
  version: string;
  /** A subset of production quick-match terminal actions, never `respond`. */
  localTerminalActions: readonly ('ignore' | 'react')[];
  /** Admin state is never an admission signal for a local outcome. */
  requireNonAdmin: true;
  /** Channel outcomes require a captured private-channel fact. */
  requirePrivateChannelForChannelOutcome: true;
  /** All non-local outcomes use the incumbent strict router stage. */
  fallbackRouter: 'two_stage_llm_router';
}

export interface FixedTraceHybridDecision {
  mode: 'local_terminal' | 'llm_router_fallback';
  reason:
    | 'production_quick_match_terminal'
    | 'no_production_quick_match'
    | 'thread_context_requires_router'
    | 'admin_requires_router'
    | 'channel_privacy_not_captured'
    | 'tool_or_mutation_capability_requires_router'
    | 'policy_disallows_terminal_action';
  plan: ExecutionPlan | null;
}

const DEFAULT_FIXED_TRACE_HYBRID_POLICY: FixedTraceHybridPolicy = Object.freeze({
  version: FIXED_TRACE_HYBRID_POLICY_VERSION,
  localTerminalActions: Object.freeze(['ignore', 'react'] as const),
  requireNonAdmin: true,
  requirePrivateChannelForChannelOutcome: true,
  fallbackRouter: 'two_stage_llm_router',
});

export function fixedTraceHybridPolicy(
  policy: FixedTraceHybridPolicy | undefined = undefined,
): FixedTraceHybridPolicy {
  return policy ?? DEFAULT_FIXED_TRACE_HYBRID_POLICY;
}

export function validateFixedTraceHybridPolicy(policy: FixedTraceHybridPolicy): void {
  if (!policy.version.trim()) throw new Error('Fixed trace hybrid policy version is required');
  if (
    !Array.isArray(policy.localTerminalActions)
    || policy.localTerminalActions.length === 0
    || policy.localTerminalActions.some((action) => action !== 'ignore' && action !== 'react')
    || new Set(policy.localTerminalActions).size !== policy.localTerminalActions.length
    || policy.requireNonAdmin !== true
    || policy.requirePrivateChannelForChannelOutcome !== true
    || policy.fallbackRouter !== 'two_stage_llm_router'
  ) throw new Error('Fixed trace hybrid policy is invalid');
}

/**
 * Make a deterministic hybrid decision from production quick-match behavior
 * and request/surface facts only.  Do not pass a trace object to this helper:
 * its routing, expectation, fixture, result, rubric, and grade fields are
 * deliberately outside the admission boundary.
 */
export function decideFixedTraceHybridRoute(input: {
  message: string;
  source: FixedTraceCase['request']['source'];
  isAdmin: boolean;
  isThread: boolean;
  channelPrivacy?: 'private' | 'public';
  policy: FixedTraceHybridPolicy;
}): FixedTraceHybridDecision {
  validateFixedTraceHybridPolicy(input.policy);
  if (input.isAdmin) return { mode: 'llm_router_fallback', reason: 'admin_requires_router', plan: null };
  if (input.isThread) return { mode: 'llm_router_fallback', reason: 'thread_context_requires_router', plan: null };
  if (input.source === 'channel' && input.channelPrivacy !== 'private') {
    return { mode: 'llm_router_fallback', reason: 'channel_privacy_not_captured', plan: null };
  }
  const plan = quickMatchRoutingContext({
    message: input.message,
    source: input.source,
    isThread: input.isThread,
    isAAOAdmin: input.isAdmin,
  });
  if (!plan) return { mode: 'llm_router_fallback', reason: 'no_production_quick_match', plan: null };
  if (plan.action === 'respond') {
    return { mode: 'llm_router_fallback', reason: 'tool_or_mutation_capability_requires_router', plan: null };
  }
  if (!input.policy.localTerminalActions.includes(plan.action)) {
    return { mode: 'llm_router_fallback', reason: 'policy_disallows_terminal_action', plan: null };
  }
  return { mode: 'local_terminal', reason: 'production_quick_match_terminal', plan };
}

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
    | 'fixture_oracle';
  intentNarrowing: 'llm_router' | 'production_quick_match_or_llm_router' | 'not_applied' | 'fixture_oracle';
  bounded: boolean;
  deployable: boolean;
  toolNames: readonly string[] | null;
}

/**
 * The fixed loop's mutation policy is fixture-derived today. A deployable
 * direct arm needs a shared request/thread-fact execution envelope before it
 * can reuse the production-equivalent executor.
 */
export interface FixedTraceExecutionEnvelopeProvenance {
  source: 'fixture_expectation' | 'request_thread_facts_not_captured' | 'fixture_oracle';
  deployable: boolean;
}

export function fixedTraceExecutionEnvelopeProvenance(
  arm: FixedTraceArchitectureArmId = 'two_stage_llm_router',
): FixedTraceExecutionEnvelopeProvenance {
  if (arm === 'direct_generation') return Object.freeze({
    source: 'request_thread_facts_not_captured',
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
      source: 'authorized_definition_handler_intersection_not_captured',
      intentNarrowing: 'not_applied',
      bounded: false,
      deployable: false,
      toolNames: null,
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
  if (arm === 'deterministic_policy_llm_fallback_hybrid') {
    return Object.freeze({
      source: 'fixture_local_routed_replay',
      intentNarrowing: 'production_quick_match_or_llm_router',
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
    surface: trace.request.source,
    isAdmin: trace.request.isAdmin,
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
  const reasons: FixedTraceDirectArmAdmissionReason[] = [];
  if (definitionProvenance === 'fixture_local') reasons.push('fixture_local_tool_definitions');

  // Do not infer a candidate surface from the definitions or fixture labels.
  // Today they are trace-local, while production's authenticated intersection
  // is neither captured here nor bounded independently of intent narrowing.
  void definitions;
  reasons.push(
    'authorized_tool_intersection_not_captured',
    'authorized_tool_universe_unbounded',
    'request_thread_execution_envelope_not_captured',
  );
  return freezeAdmission(reasons.length === 0, [...new Set(reasons)], universe);
}
