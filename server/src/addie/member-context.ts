/**
 * Member context lookup for Addie
 *
 * Resolves Slack user ID → member profile information
 * so Addie can personalize responses based on who's asking.
 */

import { SlackDatabase } from '../db/slack-db.js';
import { MemberDatabase } from '../db/member-db.js';
import { OrganizationDatabase } from '../db/organization-db.js';
import { WorkingGroupDatabase } from '../db/working-group-db.js';
import { EmailPreferencesDatabase } from '../db/email-preferences-db.js';
import { AddieDatabase } from '../db/addie-db.js';
import { workos } from '../auth/workos-client.js';
import { logger } from '../logger.js';

const slackDb = new SlackDatabase();
const memberDb = new MemberDatabase();
const orgDb = new OrganizationDatabase();
const workingGroupDb = new WorkingGroupDatabase();
const emailPrefsDb = new EmailPreferencesDatabase();
const addieDb = new AddieDatabase();

/**
 * Member context for Addie to use when responding
 */
export interface MemberContext {
  /** Whether the user is mapped to a WorkOS user */
  is_mapped: boolean;

  /** Whether the user's organization is an AgenticAdvertising.org member (has active subscription) */
  is_member: boolean;

  /** Slack user info */
  slack_user?: {
    slack_user_id: string;
    display_name: string | null;
    email: string | null;
  };

  /** WorkOS user info (if mapped) */
  workos_user?: {
    workos_user_id: string;
    email: string;
    first_name?: string;
    last_name?: string;
  };

  /** Organization info (if mapped) */
  organization?: {
    workos_organization_id: string;
    name: string;
    subscription_status: string | null;
  };

  /** Member profile info (if organization has a profile) */
  member_profile?: {
    display_name: string;
    tagline?: string;
    offerings: string[];
    headquarters?: string;
  };

  /** Subscription details */
  subscription?: {
    status: string;
    product_name?: string;
    current_period_end?: Date;
    cancel_at_period_end?: boolean;
  };

  /** Engagement signals for the organization */
  engagement?: {
    login_count_30d: number;
    last_login: Date | null;
    working_group_count: number;
    email_click_count_30d: number;
    interest_level: string | null;
  };

  /** Slack activity for the individual user */
  slack_activity?: {
    total_messages_30d: number;
    total_reactions_30d: number;
    total_thread_replies_30d: number;
    active_days_30d: number;
    last_activity_at: Date | null;
  };

  /** Organization membership info (from WorkOS) */
  org_membership?: {
    role: string;
    member_count: number;
    joined_at: Date | null;
  };

  /** Working groups the user is a member of */
  working_groups?: Array<{
    name: string;
    is_leader: boolean;
  }>;

  /** User's email subscription status */
  email_status?: {
    global_unsubscribed: boolean;
    subscribed_categories: string[];
    unsubscribed_categories: string[];
  };

  /** Whether the Slack user is linked to their AgenticAdvertising.org account */
  slack_linked: boolean;

  /** Previous Addie interactions */
  addie_history?: {
    total_interactions: number;
    last_interaction_at: Date | null;
    recent_topics: string[];
  };
}

/**
 * Look up member context from a Slack user ID
 *
 * Flow:
 * 1. Look up Slack user in slack_user_mappings
 * 2. If mapped, get WorkOS user ID
 * 3. Look up user's organization memberships in WorkOS
 * 4. Look up organization and member profile in local DB
 */
export async function getMemberContext(slackUserId: string): Promise<MemberContext> {
  const context: MemberContext = {
    is_mapped: false,
    is_member: false,
    slack_linked: false,
  };

  try {
    // Step 1: Look up Slack user mapping
    const slackMapping = await slackDb.getBySlackUserId(slackUserId);

    if (!slackMapping) {
      logger.debug({ slackUserId }, 'Addie: Slack user not found in mappings');
      return context;
    }

    context.slack_user = {
      slack_user_id: slackMapping.slack_user_id,
      display_name: slackMapping.slack_display_name || slackMapping.slack_real_name,
      email: slackMapping.slack_email,
    };

    // Step 2: Check if mapped to WorkOS user
    if (!slackMapping.workos_user_id) {
      logger.debug({ slackUserId }, 'Addie: Slack user not mapped to WorkOS');
      return context;
    }

    context.is_mapped = true;
    context.slack_linked = true;

    // Step 3: Get WorkOS user info
    let workosUser;
    try {
      workosUser = await workos.userManagement.getUser(slackMapping.workos_user_id);
      context.workos_user = {
        workos_user_id: workosUser.id,
        email: workosUser.email,
        first_name: workosUser.firstName ?? undefined,
        last_name: workosUser.lastName ?? undefined,
      };
    } catch (error) {
      logger.warn({ error, workosUserId: slackMapping.workos_user_id }, 'Addie: Failed to get WorkOS user');
      return context;
    }

    // Step 4: Get user's organization memberships
    let organizationId: string | null = null;
    let userRole: string = 'member';
    let userJoinedAt: Date | null = null;
    try {
      const memberships = await workos.userManagement.listOrganizationMemberships({
        userId: slackMapping.workos_user_id,
      });

      // Use the first organization (users typically have one org)
      if (memberships.data && memberships.data.length > 0) {
        const membership = memberships.data[0];
        organizationId = membership.organizationId;
        userRole = membership.role?.slug || 'member';
        userJoinedAt = membership.createdAt ? new Date(membership.createdAt) : null;
      }
    } catch (error) {
      logger.warn({ error, workosUserId: slackMapping.workos_user_id }, 'Addie: Failed to get org memberships');
      return context;
    }

    if (!organizationId) {
      logger.debug({ workosUserId: slackMapping.workos_user_id }, 'Addie: User has no organization');
      return context;
    }

    // Step 4b: Get org member count from WorkOS
    let memberCount = 0;
    try {
      const orgMemberships = await workos.userManagement.listOrganizationMemberships({
        organizationId: organizationId,
      });
      memberCount = orgMemberships.data?.length || 0;
    } catch (error) {
      logger.warn({ error, organizationId }, 'Addie: Failed to get org member count');
    }

    context.org_membership = {
      role: userRole,
      member_count: memberCount,
      joined_at: userJoinedAt,
    };

    // Step 5: Get organization details from local DB
    const org = await orgDb.getOrganization(organizationId);
    if (org) {
      context.organization = {
        workos_organization_id: org.workos_organization_id,
        name: org.name,
        subscription_status: org.subscription_status,
      };

      // Check if active member
      context.is_member = org.subscription_status === 'active';
    }

    // Step 6: Get member profile if exists
    const profile = await memberDb.getProfileByOrgId(organizationId);
    if (profile) {
      context.member_profile = {
        display_name: profile.display_name,
        tagline: profile.tagline,
        offerings: profile.offerings,
        headquarters: profile.headquarters,
      };
    }

    // Step 7: Get subscription details
    try {
      const subscriptionInfo = await orgDb.getSubscriptionInfo(organizationId);
      if (subscriptionInfo && subscriptionInfo.status !== 'none') {
        context.subscription = {
          status: subscriptionInfo.status,
          product_name: subscriptionInfo.product_name,
          current_period_end: subscriptionInfo.current_period_end
            ? new Date(subscriptionInfo.current_period_end * 1000)
            : undefined,
          cancel_at_period_end: subscriptionInfo.cancel_at_period_end,
        };
      }
    } catch (error) {
      logger.warn({ error, organizationId }, 'Addie: Failed to get subscription info');
    }

    // Step 8: Get engagement signals for the organization
    try {
      const engagement = await orgDb.getEngagementSignals(organizationId);
      context.engagement = {
        login_count_30d: engagement.login_count_30d,
        last_login: engagement.last_login,
        working_group_count: engagement.working_group_count,
        email_click_count_30d: engagement.email_click_count_30d,
        interest_level: engagement.interest_level,
      };
    } catch (error) {
      logger.warn({ error, organizationId }, 'Addie: Failed to get engagement signals');
    }

    // Step 9: Get Slack activity for the individual user
    try {
      const activity = await slackDb.getActivitySummary(slackUserId, { days: 30 });
      context.slack_activity = {
        total_messages_30d: activity.total_messages,
        total_reactions_30d: activity.total_reactions,
        total_thread_replies_30d: activity.total_thread_replies,
        active_days_30d: activity.active_days,
        last_activity_at: activity.last_activity_at,
      };
    } catch (error) {
      logger.warn({ error, slackUserId }, 'Addie: Failed to get Slack activity');
    }

    // Step 10: Get working groups for the user
    const workosUserId = slackMapping.workos_user_id!; // We've already validated this is not null
    try {
      const userWorkingGroups = await workingGroupDb.getWorkingGroupsForUser(workosUserId);
      if (userWorkingGroups.length > 0) {
        const workingGroupsWithLeadership = await Promise.all(
          userWorkingGroups.map(async (wg) => ({
            name: wg.name,
            is_leader: await workingGroupDb.isLeader(wg.id, workosUserId),
          }))
        );
        context.working_groups = workingGroupsWithLeadership;
      }
    } catch (error) {
      logger.warn({ error, workosUserId }, 'Addie: Failed to get working groups');
    }

    // Step 11: Get email subscription preferences
    try {
      const emailPrefs = await emailPrefsDb.getUserPreferencesByUserId(workosUserId);
      if (emailPrefs) {
        const categoryPrefs = await emailPrefsDb.getUserCategoryPreferences(workosUserId);
        context.email_status = {
          global_unsubscribed: emailPrefs.global_unsubscribe,
          subscribed_categories: categoryPrefs.filter(c => c.enabled).map(c => c.category_name),
          unsubscribed_categories: categoryPrefs.filter(c => !c.enabled).map(c => c.category_name),
        };
      }
    } catch (error) {
      logger.warn({ error, workosUserId }, 'Addie: Failed to get email preferences');
    }

    // Step 12: Get Addie interaction history for this user
    try {
      const interactions = await addieDb.getInteractions({ userId: slackUserId, limit: 10 });
      if (interactions.length > 0) {
        // Extract recent topics from input text (first 100 chars of each)
        const recentTopics = interactions
          .slice(0, 5)
          .map(i => i.input_text.substring(0, 100))
          .filter(t => t.length > 0);

        context.addie_history = {
          total_interactions: interactions.length,
          last_interaction_at: interactions[0]?.timestamp || null,
          recent_topics: recentTopics,
        };
      }
    } catch (error) {
      logger.warn({ error, slackUserId }, 'Addie: Failed to get Addie interaction history');
    }

    logger.debug(
      {
        slackUserId,
        isMapped: context.is_mapped,
        isMember: context.is_member,
        orgName: context.organization?.name,
        hasSubscription: !!context.subscription,
        hasEngagement: !!context.engagement,
        hasSlackActivity: !!context.slack_activity,
      },
      'Addie: Member context resolved'
    );

    return context;
  } catch (error) {
    logger.error({ error, slackUserId }, 'Addie: Error getting member context');
    return context;
  }
}

/**
 * Format member context for inclusion in Claude messages
 *
 * Returns a string that can be prepended to the user message
 * to give Claude context about who's asking.
 */
export function formatMemberContextForPrompt(context: MemberContext): string | null {
  // Only include context if we have meaningful info
  if (!context.is_mapped) {
    return null;
  }

  const lines: string[] = [];
  lines.push('## User Context');

  // User name
  const userName =
    context.workos_user?.first_name ||
    context.slack_user?.display_name ||
    'Unknown';
  lines.push(`The user's name is ${userName}.`);

  // Organization
  if (context.organization) {
    lines.push(`They work at ${context.organization.name}.`);

    if (context.is_member) {
      lines.push('Their organization is an active AgenticAdvertising.org member.');
    } else {
      lines.push('Their organization is not currently an AgenticAdvertising.org member.');
    }
  }

  // Member profile details
  if (context.member_profile) {
    if (context.member_profile.tagline) {
      lines.push(`Company description: ${context.member_profile.tagline}`);
    }
    if (context.member_profile.offerings && context.member_profile.offerings.length > 0) {
      lines.push(`Company offerings: ${context.member_profile.offerings.join(', ')}`);
    }
    if (context.member_profile.headquarters) {
      lines.push(`Company headquarters: ${context.member_profile.headquarters}`);
    }
  }

  // Subscription details
  if (context.subscription) {
    lines.push('');
    lines.push('### Subscription Details');
    lines.push(`Subscription status: ${context.subscription.status}`);
    if (context.subscription.product_name) {
      lines.push(`Plan: ${context.subscription.product_name}`);
    }
    if (context.subscription.current_period_end) {
      const endDate = context.subscription.current_period_end.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      lines.push(`Current period ends: ${endDate}`);
    }
    if (context.subscription.cancel_at_period_end) {
      lines.push('Note: Subscription is set to cancel at period end.');
    }
  }

  // Engagement signals
  if (context.engagement) {
    lines.push('');
    lines.push('### Organization Engagement');
    lines.push(`Dashboard logins (last 30 days): ${context.engagement.login_count_30d}`);
    if (context.engagement.last_login) {
      const lastLogin = context.engagement.last_login.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      lines.push(`Last dashboard login: ${lastLogin}`);
    }
    if (context.engagement.working_group_count > 0) {
      lines.push(`Working groups: ${context.engagement.working_group_count}`);
    }
    if (context.engagement.interest_level) {
      lines.push(`Interest level: ${context.engagement.interest_level}`);
    }
  }

  // Slack activity for the user
  if (context.slack_activity) {
    lines.push('');
    lines.push('### Slack Activity (Last 30 Days)');
    lines.push(`Messages: ${context.slack_activity.total_messages_30d}`);
    lines.push(`Thread replies: ${context.slack_activity.total_thread_replies_30d}`);
    lines.push(`Reactions: ${context.slack_activity.total_reactions_30d}`);
    lines.push(`Active days: ${context.slack_activity.active_days_30d}`);
    if (context.slack_activity.last_activity_at) {
      const lastActivity = context.slack_activity.last_activity_at.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      lines.push(`Last activity: ${lastActivity}`);
    }
  }

  // Organization membership details
  if (context.org_membership) {
    lines.push('');
    lines.push('### Organization Membership');
    lines.push(`Role: ${context.org_membership.role}`);
    lines.push(`Organization size: ${context.org_membership.member_count} users`);
    if (context.org_membership.joined_at) {
      const joinDate = context.org_membership.joined_at.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      lines.push(`Member since: ${joinDate}`);
    }
  }

  // Working groups
  if (context.working_groups && context.working_groups.length > 0) {
    lines.push('');
    lines.push('### Working Groups');
    for (const wg of context.working_groups) {
      const leaderNote = wg.is_leader ? ' (leader)' : '';
      lines.push(`- ${wg.name}${leaderNote}`);
    }
  }

  // Email preferences
  if (context.email_status) {
    lines.push('');
    lines.push('### Email Preferences');
    if (context.email_status.global_unsubscribed) {
      lines.push('Status: Globally unsubscribed from marketing emails');
    } else {
      if (context.email_status.subscribed_categories.length > 0) {
        lines.push(`Subscribed to: ${context.email_status.subscribed_categories.join(', ')}`);
      }
      if (context.email_status.unsubscribed_categories.length > 0) {
        lines.push(`Unsubscribed from: ${context.email_status.unsubscribed_categories.join(', ')}`);
      }
    }
  }

  // Slack linking status
  if (!context.slack_linked) {
    lines.push('');
    lines.push('Note: This user\'s Slack account is not yet linked to their AgenticAdvertising.org account.');
  }

  // Previous Addie interactions
  if (context.addie_history) {
    lines.push('');
    lines.push('### Previous Conversations with Addie');
    lines.push(`Total interactions: ${context.addie_history.total_interactions}`);
    if (context.addie_history.last_interaction_at) {
      const lastChat = context.addie_history.last_interaction_at.toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
      lines.push(`Last conversation: ${lastChat}`);
    }
    if (context.addie_history.recent_topics.length > 0) {
      lines.push('Recent questions:');
      for (const topic of context.addie_history.recent_topics.slice(0, 3)) {
        lines.push(`- "${topic.length > 80 ? topic.substring(0, 80) + '...' : topic}"`);
      }
    }
  }

  lines.push('');
  lines.push('Use this context to personalize your response when relevant.');
  lines.push('');

  return lines.join('\n');
}
