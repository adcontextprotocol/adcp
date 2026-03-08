/**
 * Account lifecycle and engagement computation
 *
 * Single source of truth for:
 * - Pipeline stage (prospect → member → churned)
 * - Engagement tier (prospect/registered/engaged/member)
 * - Engagement level (1-5 scale)
 * - Fire score mapping (0-4 for UI)
 * - "Hot prospect" criteria
 *
 * Both API routes and Addie tools import from here.
 */

// ============================================================================
// Pipeline stage — where the account is in the sales/membership lifecycle
// ============================================================================

export type PipelineStage =
  | 'prospect'
  | 'contacted'
  | 'responded'
  | 'interested'
  | 'negotiating'
  | 'member'
  | 'churned'
  | 'declined';

export const PIPELINE_STAGE_EMOJI: Record<PipelineStage, string> = {
  prospect: '🔍',
  contacted: '📧',
  responded: '💬',
  interested: '⭐',
  negotiating: '🤝',
  member: '✅',
  churned: '⚠️',
  declined: '❌',
};

export function computePipelineStage(org: {
  subscription_status?: string | null;
  prospect_status?: string | null;
  invoice_requested_at?: Date | null;
}): PipelineStage {
  // Active subscription (including trial) = member
  if (org.subscription_status === 'active' || org.subscription_status === 'trialing') {
    return 'member';
  }

  // Subscription ended or payment failed = churned
  if (
    org.subscription_status === 'canceled' ||
    org.subscription_status === 'past_due' ||
    org.subscription_status === 'unpaid' ||
    org.subscription_status === 'incomplete_expired'
  ) {
    return 'churned';
  }

  // Incomplete subscription = started payment but didn't finish
  if (org.subscription_status === 'incomplete') {
    return 'negotiating';
  }

  // If they have an invoice requested, they're at least negotiating
  // (only promote if they're still in early pipeline stages)
  if (org.invoice_requested_at && (!org.prospect_status || org.prospect_status === 'prospect' || org.prospect_status === 'contacted')) {
    return 'negotiating';
  }

  // Map prospect_status to pipeline stage
  const prospectStatusMap: Record<string, PipelineStage> = {
    prospect: 'prospect',
    contacted: 'contacted',
    responded: 'responded',
    interested: 'interested',
    negotiating: 'negotiating',
    converted: 'member',
    joined: 'member',
    declined: 'declined',
    inactive: 'declined',
    disqualified: 'declined',
  };

  if (org.prospect_status && prospectStatusMap[org.prospect_status]) {
    return prospectStatusMap[org.prospect_status];
  }

  return 'prospect';
}

// ============================================================================
// Engagement tier — for table/list views (how engaged is this account?)
// ============================================================================

export type EngagementTier = 'member' | 'engaged' | 'registered' | 'prospect';

export function computeEngagementTier(org: {
  subscription_status: string | null;
  subscription_canceled_at?: Date | null;
  has_users?: boolean;
  has_engaged_users?: boolean;
}): EngagementTier {
  // Member: active, non-canceled subscription (includes comped members)
  if (org.subscription_status === 'active' && !org.subscription_canceled_at) {
    return 'member';
  }

  if (org.has_engaged_users !== undefined || org.has_users !== undefined) {
    if (org.has_engaged_users) return 'engaged';
    if (org.has_users) return 'registered';
    return 'prospect';
  }

  return 'prospect';
}

// ============================================================================
// Engagement level — 1-5 scale from engagement signals
// ============================================================================

export type EngagementSignals = {
  interest_level: string | null;
  has_member_profile: boolean;
  login_count_30d: number;
  working_group_count: number;
};

export const ENGAGEMENT_LABELS = ['', 'Low', 'Some', 'Moderate', 'High', 'Very High'] as const;

export function computeEngagementLevel(signals: EngagementSignals, slackUserCount: number = 0): number {
  if (signals.interest_level === 'very_high') return 5;
  if (signals.interest_level === 'high') return 4;
  if (signals.working_group_count > 0) return 4;
  if (signals.has_member_profile) return 4;
  if (signals.login_count_30d > 3) return 3;
  if (slackUserCount > 0) return 3;
  if (signals.login_count_30d > 0) return 2;
  return 1;
}

// ============================================================================
// Fire score — map 0-100 engagement_score to 0-4 fires for UI
// ============================================================================

export function scoreToFires(score: number): number {
  if (score >= 76) return 4;
  if (score >= 56) return 3;
  if (score >= 36) return 2;
  if (score >= 16) return 1;
  return 0;
}

// ============================================================================
// "Hot prospect" criteria — used in SQL filters and business logic
// ============================================================================

export const HOT_PROSPECT_SCORE_THRESHOLD = 50;
export const HOT_PROSPECT_INTEREST_LEVELS = ['high', 'very_high'] as const;

export function isHotProspect(org: {
  engagement_score?: number | null;
  interest_level?: string | null;
}): boolean {
  if ((org.engagement_score ?? 0) >= HOT_PROSPECT_SCORE_THRESHOLD) return true;
  if (org.interest_level && (HOT_PROSPECT_INTEREST_LEVELS as readonly string[]).includes(org.interest_level)) return true;
  return false;
}

// ============================================================================
// "Going cold" threshold
// ============================================================================

export const GOING_COLD_DAYS = 30;
export const GOING_COLD_MIN_SCORE = 30;
