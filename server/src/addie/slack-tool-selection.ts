import type { ExecutionPlan } from './router.js';
import {
  buildUnavailableSetsHint,
  getSafeReadOnlyFallbackTools,
  getToolsForSets,
  getValidToolSetNames,
  MAX_DIRECT_ROUTED_TOOL_SET_COUNT,
  SAFE_KNOWLEDGE_FALLBACK_TOOL_SETS,
} from './tool-sets.js';

export type SlackToolSource = 'dm' | 'mention' | 'channel';
export type SystemChannelRole = 'prospect' | 'escalation' | 'billing' | 'error' | 'admin';
export type ActiveCertificationKind = 'learning' | 'assessment' | 'mixed';

export const ADMIN_CHANNEL_WG_SLUG = 'aao-admin';

/** Tool sets required by server-owned channel configuration. */
export const SYSTEM_CHANNEL_TOOL_SETS: Readonly<Record<SystemChannelRole, readonly string[]>> = {
  prospect: ['admin_prospects', 'outreach'],
  // Escalation tools are already in ALWAYS_AVAILABLE_ADMIN_TOOLS.
  escalation: [],
  billing: ['billing'],
  error: ['admin_workflows'],
  // Generic admin channels rely on the router's bounded domain selection.
  admin: [],
};

export interface SlackToolSetSelectionInput {
  routerSelectedSets?: readonly string[];
  routerAvailable: boolean;
  source: SlackToolSource;
  isAdmin: boolean;
  workingGroupSlug?: string | null;
  systemRole?: SystemChannelRole | null;
  /** Authoritative active-module kind; overrides normal routing only in DMs. */
  activeCertificationKind?: ActiveCertificationKind | null;
  /** Legacy boolean callers receive the mixed compatibility-safe workflow. */
  hasActiveCertification?: boolean;
  /** Relevant SI retrievals or an active session make brand-agent tools actionable. */
  hasSponsoredIntelligenceContext?: boolean;
}

export function hasActiveCertificationProgress(
  progress: readonly { status: string; module_id?: string | null }[],
): boolean {
  return classifyActiveCertificationProgress(progress) !== null;
}

/** Classify trusted in-progress state so active DMs receive one bounded workflow. */
export function classifyActiveCertificationProgress(
  progress: readonly { status: string; module_id?: string | null }[],
): ActiveCertificationKind | null {
  let hasLearning = false;
  let hasAssessment = false;
  for (const entry of progress) {
    if (entry.status !== 'in_progress') continue;
    if (entry.module_id?.toUpperCase().startsWith('S')) {
      hasAssessment = true;
    } else {
      hasLearning = true;
    }
  }
  if (hasLearning && hasAssessment) return 'mixed';
  if (hasAssessment) return 'assessment';
  if (hasLearning) return 'learning';
  return null;
}

function appendUnique(target: string[], values: readonly string[]): void {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
}

/** Apply server-owned Slack routing rules after the router proposes sets. */
export function selectSlackToolSets(input: SlackToolSetSelectionInput): string[] {
  const activeCertificationKind = input.activeCertificationKind
    ?? (input.hasActiveCertification ? 'mixed' : null);
  if (input.source === 'dm' && activeCertificationKind) {
    const certificationSets = activeCertificationKind === 'mixed'
      ? ['certification_learning', 'certification_assessment']
      : [`certification_${activeCertificationKind}`];
    return [...certificationSets, ...SAFE_KNOWLEDGE_FALLBACK_TOOL_SETS, 'illustrations'];
  }

  const selected = input.routerAvailable
    ? [...(input.routerSelectedSets ?? [])]
      .filter((name) => getValidToolSetNames(input.isAdmin).has(name))
    : [...SAFE_KNOWLEDGE_FALLBACK_TOOL_SETS];

  // Direct conversations must always retain Addie's authoritative docs and
  // public-repository lookup. The response model is instructed to verify
  // questions about Addie's own capabilities, so an empty or overly narrow
  // router plan must not make those tools disappear from DMs or mentions.
  if (input.source === 'dm' || input.source === 'mention') {
    appendUnique(selected, ['knowledge']);
  }

  if (input.isAdmin && input.systemRole) {
    appendUnique(selected, SYSTEM_CHANNEL_TOOL_SETS[input.systemRole] ?? []);
  }

  if (input.hasSponsoredIntelligenceContext) {
    appendUnique(selected, ['sponsored_intelligence']);
  }

  return selected;
}

/**
 * Delivery-neutral name for the bounded direct-interaction selection policy.
 * Slack retains its established export while web chat shares the exact policy.
 */
export const selectRoutedToolSets = selectSlackToolSets;

export interface BoundedRoutedToolSetSelectionInput {
  /** A plan is trusted only after it has passed the bounded-domain checks below. */
  plan: ExecutionPlan | null;
  routerAvailable: boolean;
  source: SlackToolSource;
  isAdmin: boolean;
  isPublicChannel?: boolean;
  workingGroupSlug?: string | null;
  systemRole?: SystemChannelRole | null;
  activeCertificationKind?: ActiveCertificationKind | null;
  hasSponsoredIntelligenceContext?: boolean;
  /** Exact definition-and-handler availability at the delivery boundary. */
  isToolAvailable?: (toolName: string) => boolean;
}

export interface BoundedRoutedToolSetSelection {
  selectedToolSets: string[];
  allowedToolNames: string[];
  unavailableHint: string;
  useSafeFallback: boolean;
}

/**
 * Validate a direct, user-visible routed response before tool or prompt
 * assembly. Delivery layers retain ownership of how a response is triggered
 * and delivered; this policy only determines the request-scoped capability
 * surface. A router error, non-response action, empty/stale/unauthorized
 * domain, or an over-broad plan receives the explicit read-only fallback.
 */
export function selectBoundedRoutedToolSets(
  input: BoundedRoutedToolSetSelectionInput,
): BoundedRoutedToolSetSelection {
  const validToolSets = getValidToolSetNames(input.isAdmin);
  const respondPlan = input.plan?.action === 'respond' ? input.plan : null;
  const hasValidRespondPlan = input.routerAvailable
    && respondPlan !== null
    && Array.isArray(respondPlan.tool_sets)
    && respondPlan.tool_sets.length > 0
    && respondPlan.tool_sets.length <= MAX_DIRECT_ROUTED_TOOL_SET_COUNT
    && respondPlan.tool_sets.every((name) => typeof name === 'string' && validToolSets.has(name));
  let useSafeFallback = !hasValidRespondPlan;

  // Never retain certification, Sponsored Intelligence, or server-configured
  // channel overlays when routing is unavailable or untrusted. They may be
  // added only to a valid, bounded response plan below.
  let selectedToolSets = selectRoutedToolSets({
    routerSelectedSets: hasValidRespondPlan
      ? respondPlan.tool_sets
      : [...SAFE_KNOWLEDGE_FALLBACK_TOOL_SETS],
    routerAvailable: hasValidRespondPlan,
    source: input.source,
    isAdmin: input.isAdmin,
    workingGroupSlug: useSafeFallback ? undefined : input.workingGroupSlug,
    systemRole: useSafeFallback ? undefined : input.systemRole,
    activeCertificationKind: useSafeFallback ? null : input.activeCertificationKind,
    hasSponsoredIntelligenceContext: useSafeFallback
      ? false
      : input.hasSponsoredIntelligenceContext,
  });
  let allowedToolNames = useSafeFallback
    ? getSafeReadOnlyFallbackTools()
    : getToolsForSets(selectedToolSets, input.isAdmin, input.isPublicChannel);
  const isToolAvailable = input.isToolAvailable;
  if (!useSafeFallback && isToolAvailable && allowedToolNames.some((name) =>
    name !== 'web_search' && !isToolAvailable(name),
  )) {
    // A bounded domain with an incomplete registration is no safer than a
    // stale router result. Do not hand a model a definition without its
    // handler (or vice versa); recover to the read-only domain instead.
    useSafeFallback = true;
    selectedToolSets = selectRoutedToolSets({
      routerSelectedSets: [...SAFE_KNOWLEDGE_FALLBACK_TOOL_SETS],
      routerAvailable: false,
      source: input.source,
      isAdmin: input.isAdmin,
      activeCertificationKind: null,
      hasSponsoredIntelligenceContext: false,
    });
    allowedToolNames = getSafeReadOnlyFallbackTools();
  }

  // The provider-managed web search tool has no custom handler. Every other
  // name must remain in the exact definition/handler intersection, including
  // in the read-only fallback when a deployment has a partial registration.
  if (isToolAvailable) {
    allowedToolNames = allowedToolNames.filter((name) =>
      name === 'web_search' || isToolAvailable(name),
    );
  }

  return {
    selectedToolSets,
    allowedToolNames,
    unavailableHint: buildUnavailableSetsHint(selectedToolSets, input.isAdmin),
    useSafeFallback,
  };
}

/** Normalize Slack conversation privacy, including DM shapes that omit is_private. */
export function resolveSlackChannelPrivacy(channel: {
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
}): boolean | null {
  if (channel.is_im === true || channel.is_mpim === true) return true;
  return typeof channel.is_private === 'boolean' ? channel.is_private : null;
}

/** Resolve privacy-sensitive channel context without exposing resolver errors. */
export async function resolveRequiredSlackChannelContext<
  T extends { viewing_channel_is_private?: boolean },
>(
  channelId: string,
  resolver: (id: string) => Promise<T>,
): Promise<T | null> {
  try {
    const context = await resolver(channelId);
    return typeof context.viewing_channel_is_private === 'boolean'
      ? context
      : null;
  } catch {
    return null;
  }
}
