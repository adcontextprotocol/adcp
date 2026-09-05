import type { AddieTool } from '../types.js';
import { FIXED_TRACE_DIRECT_TOOL_UNIVERSE } from '../direct-tool-universe.js';
import { quickMatchRoutingContext, type ExecutionPlan } from '../router.js';
import { createHash } from 'node:crypto';
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
    routeSource: 'reviewed_safe_subset_of_production_quick_match_with_unchanged_llm_fallback',
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
export const FIXED_TRACE_HYBRID_POLICY_VERSION = 'fixed-trace-hybrid-safe-subset-v2';
export const FIXED_TRACE_HYBRID_SAFETY_GATE_VERSION = 'exact-harmless-terminal-admission-v1';

export class FixedTraceHybridAdmissionSnapshotError extends Error {
  readonly code = 'invalid_hybrid_admission_snapshot';

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FixedTraceHybridAdmissionSnapshotError';
  }
}

export interface FixedTraceHybridPolicy {
  version: string;
  /** The reviewed fail-closed admission gate, bound into cohort provenance. */
  safetyGateVersion: typeof FIXED_TRACE_HYBRID_SAFETY_GATE_VERSION;
  safetyGateStatus: 'reviewed_safe_subset';
  /** This arm never claims to run the full production substring matcher. */
  localAdmissionSource: 'reviewed_safe_subset_of_production_quick_match';
  fallbackSource: 'unchanged_incumbent_two_stage_llm_router';
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
    | 'unsafe_or_ambiguous_message'
    | 'quick_match_exception'
    | 'tool_or_mutation_capability_requires_router'
    | 'policy_disallows_terminal_action';
  plan: ExecutionPlan | null;
}

const DEFAULT_FIXED_TRACE_HYBRID_POLICY: FixedTraceHybridPolicy = Object.freeze({
  version: FIXED_TRACE_HYBRID_POLICY_VERSION,
  safetyGateVersion: FIXED_TRACE_HYBRID_SAFETY_GATE_VERSION,
  safetyGateStatus: 'reviewed_safe_subset',
  localAdmissionSource: 'reviewed_safe_subset_of_production_quick_match',
  fallbackSource: 'unchanged_incumbent_two_stage_llm_router',
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
    || policy.safetyGateVersion !== FIXED_TRACE_HYBRID_SAFETY_GATE_VERSION
    || policy.safetyGateStatus !== 'reviewed_safe_subset'
    || policy.localAdmissionSource !== 'reviewed_safe_subset_of_production_quick_match'
    || policy.fallbackSource !== 'unchanged_incumbent_two_stage_llm_router'
    || policy.requireNonAdmin !== true
    || policy.requirePrivateChannelForChannelOutcome !== true
    || policy.fallbackRouter !== 'two_stage_llm_router'
  ) throw new Error('Fixed trace hybrid policy is invalid');
}

type HybridAdmissionSnapshot = Readonly<{
  message: string;
  source: FixedTraceCase['request']['source'];
  isAdmin: boolean;
  isThread: boolean;
  channelPrivacy?: 'private' | 'public';
}>;

type HybridQuickMatcher = (context: Readonly<{
  message: string;
  source: 'dm' | 'channel';
  isThread: boolean;
  isAAOAdmin: boolean;
}>) => ExecutionPlan | null;

function ownDataProperty(source: unknown, name: string, owner = 'input'): unknown {
  try {
    if (typeof source !== 'object' || source === null) {
      throw new FixedTraceHybridAdmissionSnapshotError(`Hybrid admission ${owner} must be an object`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(source, name);
    if (!descriptor || !('value' in descriptor)) {
      throw new FixedTraceHybridAdmissionSnapshotError(`Hybrid admission ${owner}.${name} must be an own data property`);
    }
    return descriptor.value;
  } catch (error) {
    if (error instanceof FixedTraceHybridAdmissionSnapshotError) throw error;
    throw new FixedTraceHybridAdmissionSnapshotError(`Hybrid admission ${owner}.${name} could not be snapshotted`, { cause: error });
  }
}

/**
 * This reads request facts once from data descriptors and detaches them before
 * any matcher can execute. Proxies/accessors therefore abort before router or
 * provider dispatch rather than participating in routing.
 */
function snapshotHybridAdmissionInput(input: unknown): HybridAdmissionSnapshot {
  const message = ownDataProperty(input, 'message');
  const source = ownDataProperty(input, 'source');
  const isAdmin = ownDataProperty(input, 'isAdmin');
  const isThread = ownDataProperty(input, 'isThread');
  let channelPrivacy: unknown;
  try {
    const descriptor = typeof input === 'object' && input !== null
      ? Object.getOwnPropertyDescriptor(input, 'channelPrivacy')
      : undefined;
    if (descriptor && !('value' in descriptor)) {
      throw new FixedTraceHybridAdmissionSnapshotError('Hybrid admission input.channelPrivacy must be an own data property');
    }
    channelPrivacy = descriptor?.value;
  } catch (error) {
    if (error instanceof FixedTraceHybridAdmissionSnapshotError) throw error;
    throw new FixedTraceHybridAdmissionSnapshotError('Hybrid admission input.channelPrivacy could not be snapshotted', { cause: error });
  }
  if (
    typeof message !== 'string'
    || (source !== 'dm' && source !== 'channel')
    || typeof isAdmin !== 'boolean'
    || typeof isThread !== 'boolean'
    || (channelPrivacy !== undefined && channelPrivacy !== 'private' && channelPrivacy !== 'public')
  ) throw new FixedTraceHybridAdmissionSnapshotError('Hybrid admission input has invalid request facts');
  return Object.freeze({ message, source, isAdmin, isThread, ...(channelPrivacy === undefined ? {} : { channelPrivacy }) });
}

function snapshotHybridPolicy(input: unknown): FixedTraceHybridPolicy {
  const policy = ownDataProperty(input, 'policy');
  const localTerminalActions = ownDataProperty(policy, 'localTerminalActions', 'policy');
  if (!Array.isArray(localTerminalActions)) {
    throw new FixedTraceHybridAdmissionSnapshotError('Hybrid admission policy.localTerminalActions must be an array');
  }
  const actionLength = ownDataProperty(localTerminalActions, 'length', 'policy.localTerminalActions');
  if (typeof actionLength !== 'number' || !Number.isSafeInteger(actionLength) || actionLength < 0 || actionLength > 2) {
    throw new FixedTraceHybridAdmissionSnapshotError('Hybrid admission policy.localTerminalActions has invalid length');
  }
  const actions = Array.from({ length: actionLength }, (_, index) => (
    ownDataProperty(localTerminalActions, String(index), 'policy.localTerminalActions')
  ));
  const snapshot = Object.freeze({
    version: ownDataProperty(policy, 'version', 'policy'),
    safetyGateVersion: ownDataProperty(policy, 'safetyGateVersion', 'policy'),
    safetyGateStatus: ownDataProperty(policy, 'safetyGateStatus', 'policy'),
    localAdmissionSource: ownDataProperty(policy, 'localAdmissionSource', 'policy'),
    fallbackSource: ownDataProperty(policy, 'fallbackSource', 'policy'),
    localTerminalActions: Object.freeze(actions),
    requireNonAdmin: ownDataProperty(policy, 'requireNonAdmin', 'policy'),
    requirePrivateChannelForChannelOutcome: ownDataProperty(policy, 'requirePrivateChannelForChannelOutcome', 'policy'),
    fallbackRouter: ownDataProperty(policy, 'fallbackRouter', 'policy'),
  }) as FixedTraceHybridPolicy;
  try {
    validateFixedTraceHybridPolicy(snapshot);
  } catch (error) {
    throw new FixedTraceHybridAdmissionSnapshotError('Hybrid admission policy is invalid', { cause: error });
  }
  return snapshot;
}

type SafeTerminalForm = Readonly<{ action: 'ignore' | 'react'; emoji?: string }>;

const SAFE_IGNORE_FORMS = new Set([
  'ok', 'okay', 'k', 'got it', 'cool', 'nice', 'lol', 'haha', 'sounds good',
  'will do', 'on it', 'done', 'working on it',
]);
const SAFE_REACT_FORMS = new Map<string, string>([
  ['hi', 'wave'], ['hello', 'wave'], ['hey', 'wave'], ['good morning', 'wave'],
  ['good afternoon', 'wave'], ['howdy', 'wave'], ['thanks', 'heart'], ['thank you', 'heart'],
]);
const UNSAFE_OR_AMBIGUOUS_LANGUAGE = /\b(?:no|not|never|don't|do\s+not|delete|remove|ship|send|invoice|billing|payment|account|admin|tool|generate|create|update|change|cancel|refund|user)\b/i;
const UNSAFE_DELIMITER_OR_QUOTE = /["'`;,:|/\\]/;
const CONTROL_OR_LINE_SEPARATOR = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Reviewed evaluator-only subset of production quick-match. It deliberately
 * accepts only fully consumed exact harmless forms after bounded normalization;
 * production's wider substring matcher remains unchanged and is not evidence.
 */
function safeTerminalForm(snapshot: HybridAdmissionSnapshot): SafeTerminalForm | null {
  if (Buffer.byteLength(snapshot.message, 'utf8') > 128) return null;
  if (CONTROL_OR_LINE_SEPARATOR.test(snapshot.message) || UNSAFE_DELIMITER_OR_QUOTE.test(snapshot.message)) return null;
  const normalized = snapshot.message
    .normalize('NFKC')
    .toLowerCase()
    .trim()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"');
  if (!normalized || UNSAFE_OR_AMBIGUOUS_LANGUAGE.test(normalized)) return null;
  if (SAFE_IGNORE_FORMS.has(normalized) || (normalized.endsWith('.') && SAFE_IGNORE_FORMS.has(normalized.slice(0, -1)))) {
    return Object.freeze({ action: 'ignore' });
  }
  const emoji = SAFE_REACT_FORMS.get(normalized);
  return emoji ? Object.freeze({ action: 'react', emoji }) : null;
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
  /** Internal test seam; production uses the unchanged quick-match function. */
  quickMatcher?: HybridQuickMatcher;
}): FixedTraceHybridDecision {
  const snapshot = snapshotHybridAdmissionInput(input);
  // Request facts are snapshotted before policy validation or matcher code.
  // A hostile request accessor therefore cannot run after a dispatch boundary.
  const policy = snapshotHybridPolicy(input);
  if (snapshot.isAdmin) return { mode: 'llm_router_fallback', reason: 'admin_requires_router', plan: null };
  if (snapshot.isThread) return { mode: 'llm_router_fallback', reason: 'thread_context_requires_router', plan: null };
  if (snapshot.source === 'channel' && snapshot.channelPrivacy !== 'private') {
    return { mode: 'llm_router_fallback', reason: 'channel_privacy_not_captured', plan: null };
  }
  const safeForm = safeTerminalForm(snapshot);
  if (!safeForm) return { mode: 'llm_router_fallback', reason: 'unsafe_or_ambiguous_message', plan: null };
  let matcher: HybridQuickMatcher;
  try {
    const suppliedMatcher = Object.getOwnPropertyDescriptor(input, 'quickMatcher');
    if (suppliedMatcher && !('value' in suppliedMatcher)) throw new Error('quickMatcher accessor');
    if (suppliedMatcher?.value !== undefined && typeof suppliedMatcher.value !== 'function') {
      throw new Error('quickMatcher is not a function');
    }
    matcher = suppliedMatcher?.value ?? quickMatchRoutingContext;
  } catch {
    return { mode: 'llm_router_fallback', reason: 'quick_match_exception', plan: null };
  }
  let matchedAction: 'ignore' | 'react' | 'respond' | null;
  let matchedEmoji: string | undefined;
  try {
    const plan = matcher(Object.freeze({
      message: snapshot.message,
      source: snapshot.source,
      isThread: snapshot.isThread,
      isAAOAdmin: snapshot.isAdmin,
    }));
    matchedAction = plan?.action ?? null;
    matchedEmoji = plan?.action === 'react' ? plan.emoji : undefined;
  } catch {
    return { mode: 'llm_router_fallback', reason: 'quick_match_exception', plan: null };
  }
  if (!matchedAction) return { mode: 'llm_router_fallback', reason: 'no_production_quick_match', plan: null };
  if (matchedAction === 'respond') {
    return { mode: 'llm_router_fallback', reason: 'tool_or_mutation_capability_requires_router', plan: null };
  }
  if (matchedAction !== safeForm.action || !policy.localTerminalActions.includes(matchedAction)) {
    return { mode: 'llm_router_fallback', reason: 'policy_disallows_terminal_action', plan: null };
  }
  if (matchedAction === 'react' && matchedEmoji !== safeForm.emoji) {
    return { mode: 'llm_router_fallback', reason: 'policy_disallows_terminal_action', plan: null };
  }
  return {
    mode: 'local_terminal',
    reason: 'production_quick_match_terminal',
    plan: safeForm.action === 'react'
      ? Object.freeze({
          action: 'react' as const,
          emoji: safeForm.emoji!,
          reason: 'Reviewed exact harmless terminal form',
          decision_method: 'quick_match' as const,
        })
      : Object.freeze({
          action: 'ignore' as const,
          reason: 'Reviewed exact harmless terminal form',
          decision_method: 'quick_match' as const,
        }),
  };
}

export function fixedTraceArchitectureArm(
  arm: FixedTraceArchitectureArmId = 'two_stage_llm_router',
): FixedTraceArchitectureArmProvenance {
  return FIXED_TRACE_ARCHITECTURE_ARMS[arm];
}

export type FixedTraceToolDefinitionProvenance =
  | 'fixture_local'
  | 'authorized_definition_handler_intersection'
  | 'evaluator_owned_production_definitions_simulated_receipts';

/**
 * Records what selected the candidate's visible tools.  The production
 * definition/handler intersection is authorization-aware, but it is currently
 * wider than the bounded routed surface and is not exposed by this evaluator.
 */
export interface FixedTraceToolUniverseProvenance {
  source:
    | 'fixture_local_routed_replay'
    | 'authorized_definition_handler_intersection_not_captured'
    | 'evaluator_owned_production_definitions_simulated_receipts'
    | 'fixture_oracle';
  intentNarrowing: 'llm_router' | 'production_quick_match_or_llm_router' | 'not_applied' | 'fixture_oracle';
  bounded: boolean;
  deployable: boolean;
  toolNames: readonly string[] | null;
  toolNamesSha256?: string | null;
  toolSchemaSha256?: string | null;
  definitionHandlerSha256?: string | null;
}

export interface FixedTraceRequestThreadFactsProvenance {
  source: 'not_applicable' | 'fixture_case_request_not_authenticated';
  traceFacts: readonly Readonly<{
    traceId: string;
    requestThreadFactsSha256: string;
    provenance: 'fixture_case_request_not_authenticated';
  }>[];
}

export interface FixedTraceDirectRequestThreadFacts {
  source: FixedTraceCase['request']['source'];
  isAAOAdmin: boolean;
  isThread: boolean;
  channelPrivacy: 'private' | 'unknown';
  authentication: 'not_authenticated_fixture_claim';
  provenance: 'fixture_case_request_not_authenticated';
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error('Cannot canonicalize a non-JSON request/thread fact');
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** Preserve fixture-visible facts exactly; never manufacture production auth/context. */
export function fixedTraceDirectRequestThreadFacts(trace: FixedTraceCase): FixedTraceDirectRequestThreadFacts {
  return Object.freeze({
    source: trace.request.source,
    isAAOAdmin: trace.request.isAdmin,
    isThread: (trace.request.threadContext?.length ?? 0) > 0,
    channelPrivacy: trace.request.source === 'dm' ? 'private' : 'unknown',
    authentication: 'not_authenticated_fixture_claim',
    provenance: 'fixture_case_request_not_authenticated',
  });
}

export function fixedTraceRequestThreadFactsProvenance(
  traceSuite: ReadonlyArray<FixedTraceCase>,
  arm: FixedTraceArchitectureArmId = 'two_stage_llm_router',
): FixedTraceRequestThreadFactsProvenance {
  if (arm !== 'direct_generation') return Object.freeze({ source: 'not_applicable', traceFacts: [] });
  return Object.freeze({
    source: 'fixture_case_request_not_authenticated',
    traceFacts: Object.freeze(traceSuite.map((trace) => Object.freeze({
      traceId: trace.id,
      requestThreadFactsSha256: sha256(fixedTraceDirectRequestThreadFacts(trace)),
      provenance: 'fixture_case_request_not_authenticated' as const,
    })).sort((left, right) => left.traceId.localeCompare(right.traceId))),
  });
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
      source: 'evaluator_owned_production_definitions_simulated_receipts',
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
  | 'request_thread_execution_envelope_not_captured'
  | 'production_binding_contract_not_captured'
  | 'request_thread_facts_not_authenticated'
  | 'evaluator_simulated_receipt_handlers';

export interface FixedTraceDirectToolUniverse extends FixedTraceToolUniverseProvenance {
  surface: FixedTraceCase['request']['source'];
  isAdmin: boolean;
  isThread: boolean;
  channelPrivacy: 'private' | 'unknown';
  requestThreadFactsSha256: string;
  requestThreadFactsProvenance: 'fixture_case_request_not_authenticated';
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
  const facts = fixedTraceDirectRequestThreadFacts(trace);
  return Object.freeze({
    ...fixedTraceToolUniverseProvenance('direct_generation'),
    // These remain fixture claims, not production authentication. They are
    // retained for audit and bound to the cohort, never replaced by a DM.
    surface: facts.source,
    isAdmin: facts.isAAOAdmin,
    isThread: facts.isThread,
    channelPrivacy: facts.channelPrivacy,
    requestThreadFactsSha256: sha256(facts),
    requestThreadFactsProvenance: facts.provenance,
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
  // The evaluator has production definitions but only simulated/offline
  // receipts and fixture claims. It has no authenticated production binding
  // contract or request/thread envelope, so it must reject before dispatch.
  void definitions;
  void definitionProvenance;
  return freezeAdmission(false, [
    'production_binding_contract_not_captured',
    'request_thread_facts_not_authenticated',
    'evaluator_simulated_receipt_handlers',
  ], universe);
}
