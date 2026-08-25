import type { ExecutionPlan } from '../router.js';
import type { SIRetrievalResult } from '../services/si-retriever.js';

export const OFFICIAL_DOCS_PROFILE = 'official_docs_v1' as const;
export const OFFICIAL_DOCS_POLICY_VERSION = 'official-docs-policy:v1' as const;
export const OFFICIAL_DOCS_ALLOWED_TOOLS = ['search_docs', 'get_doc'] as const;

export type ChannelCapabilityProfile = typeof OFFICIAL_DOCS_PROFILE;

export type ProfiledChannelRespondPlan = Extract<ExecutionPlan, { action: 'respond' }> & {
  capability_profile?: ChannelCapabilityProfile;
  capability_profile_reason?: OfficialDocsCohortReason;
};

interface CohortEnvironment {
  ADDIE_OFFICIAL_DOCS_COHORT_ENABLED?: string;
  ADDIE_OFFICIAL_DOCS_COHORT_CHANNEL_IDS?: string;
}

export type OfficialDocsCohortReason =
  | 'eligible'
  | 'disabled'
  | 'channel_not_allowlisted'
  | 'channel_not_public'
  | 'admin_user'
  | 'not_high_confidence_knowledge'
  | 'specialized_model_required'
  | 'si_context_present';

export interface OfficialDocsCohortDecision {
  eligible: boolean;
  reason: OfficialDocsCohortReason;
  profile: ChannelCapabilityProfile | null;
}

function allowlistedChannels(env: CohortEnvironment): Set<string> {
  return new Set(
    (env.ADDIE_OFFICIAL_DOCS_COHORT_CHANNEL_IDS ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

export function normalizeReplayableSiResult(
  value: SIRetrievalResult | null | undefined,
): SIRetrievalResult | null {
  return value?.agents.length ? value : null;
}

/**
 * Admit only an explicit public-channel cohort whose ordinary production
 * response uses the same bounded capability profile as a suppressed replay.
 * The decision is made before suppression and persisted with the router plan.
 */
export function selectOfficialDocsCohort(
  input: {
    channelId: string;
    channelIsPublic: boolean;
    isAdmin: boolean;
    channelUsesDepthModel: boolean;
    plan: ExecutionPlan;
    siRetrievalResult: SIRetrievalResult | null | undefined;
  },
  env: CohortEnvironment = process.env,
): OfficialDocsCohortDecision {
  const base = {
    profile: null,
  } as const;
  if (env.ADDIE_OFFICIAL_DOCS_COHORT_ENABLED !== 'true') {
    return { ...base, eligible: false, reason: 'disabled' };
  }
  if (!allowlistedChannels(env).has(input.channelId)) {
    return { ...base, eligible: false, reason: 'channel_not_allowlisted' };
  }
  if (!input.channelIsPublic) {
    return { ...base, eligible: false, reason: 'channel_not_public' };
  }
  if (input.isAdmin) return { ...base, eligible: false, reason: 'admin_user' };
  if (
    input.plan.action !== 'respond'
    || input.plan.confidence !== 'high'
    || input.plan.tool_sets.length !== 1
    || input.plan.tool_sets[0] !== 'knowledge'
  ) {
    return { ...base, eligible: false, reason: 'not_high_confidence_knowledge' };
  }
  if (input.plan.requires_precision || input.plan.requires_depth || input.channelUsesDepthModel) {
    return { ...base, eligible: false, reason: 'specialized_model_required' };
  }
  if (normalizeReplayableSiResult(input.siRetrievalResult)) {
    return { ...base, eligible: false, reason: 'si_context_present' };
  }
  return {
    eligible: true,
    reason: 'eligible',
    profile: OFFICIAL_DOCS_PROFILE,
  };
}

export function applyOfficialDocsProfile(
  plan: Extract<ExecutionPlan, { action: 'respond' }>,
): ProfiledChannelRespondPlan {
  return {
    ...plan,
    capability_profile: OFFICIAL_DOCS_PROFILE,
    capability_profile_reason: 'eligible',
  };
}

export function isOfficialDocsProfile(
  plan: { capability_profile?: unknown; capability_profile_reason?: unknown },
): plan is {
  capability_profile: ChannelCapabilityProfile;
  capability_profile_reason: 'eligible';
} {
  return plan.capability_profile === OFFICIAL_DOCS_PROFILE
    && plan.capability_profile_reason === 'eligible';
}

export function hasOfficialDocsToolBoundary(
  client: { hasRegisteredTools(names: readonly string[]): boolean } | null,
): boolean {
  return client?.hasRegisteredTools(OFFICIAL_DOCS_ALLOWED_TOOLS) === true;
}

/** One canonical shape is persisted and signed; undefined router metadata is omitted by JSON. */
export function canonicalOfficialDocsPlan(
  plan: ProfiledChannelRespondPlan,
): ProfiledChannelRespondPlan {
  return {
    action: 'respond',
    reason: plan.reason,
    decision_method: plan.decision_method,
    latency_ms: plan.latency_ms,
    tokens_input: plan.tokens_input,
    tokens_output: plan.tokens_output,
    model: plan.model,
    requires_precision: plan.requires_precision,
    requires_depth: plan.requires_depth,
    tool_sets: [...plan.tool_sets],
    confidence: plan.confidence,
    capability_profile: plan.capability_profile,
    capability_profile_reason: plan.capability_profile_reason,
  };
}
