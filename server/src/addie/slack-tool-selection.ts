import { getValidToolSetNames, SAFE_KNOWLEDGE_FALLBACK_TOOL_SETS } from './tool-sets.js';

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
