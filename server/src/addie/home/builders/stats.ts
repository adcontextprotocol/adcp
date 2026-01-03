/**
 * Stats Builder
 *
 * Builds user engagement and membership statistics.
 */

import type { UserStats } from '../types.js';
import type { MemberContext } from '../../member-context.js';

/**
 * Build user stats from member context
 */
export function buildStats(memberContext: MemberContext): UserStats | null {
  // Only show stats for mapped users
  if (!memberContext.is_mapped) {
    return null;
  }

  return {
    memberSince: memberContext.org_membership?.joined_at ?? null,
    workingGroupCount: memberContext.engagement?.working_group_count ?? 0,
    slackActivity: memberContext.slack_activity
      ? {
          messages30d: memberContext.slack_activity.total_messages_30d,
          activeDays30d: memberContext.slack_activity.active_days_30d,
        }
      : null,
    subscriptionStatus: memberContext.subscription?.status ?? null,
    renewalDate: memberContext.subscription?.current_period_end ?? null,
  };
}
