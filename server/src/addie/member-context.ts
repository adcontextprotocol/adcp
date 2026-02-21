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
import { JoinRequestDatabase } from '../db/join-request-db.js';
import { OrgKnowledgeDatabase } from '../db/org-knowledge-db.js';
import { getThreadService } from './thread-service.js';
import { workos } from '../auth/workos-client.js';
import { logger } from '../logger.js';
import { getPool, query } from '../db/client.js';
import { resolveSlackUserDisplayName } from '../slack/client.js';
import { PERSONA_LABELS } from '../config/personas.js';

const slackDb = new SlackDatabase();
const memberDb = new MemberDatabase();
const orgDb = new OrganizationDatabase();
const workingGroupDb = new WorkingGroupDatabase();
const emailPrefsDb = new EmailPreferencesDatabase();
const addieDb = new AddieDatabase();
const joinRequestDb = new JoinRequestDatabase();
const orgKnowledgeDb = new OrgKnowledgeDatabase();

/**
 * Get pending content count for a user
 * Returns counts for committee leads (their committees) and admins (all)
 */
async function getPendingContentForUser(
  workosUserId: string,
  isAAOAdmin: boolean
): Promise<{ total: number; by_committee: Record<string, number> }> {
  const pool = getPool();

  // Get committees user leads
  // Join with slack_user_mappings to handle users who were added as leader via Slack ID
  const leaderResult = await pool.query(
    `SELECT wg.id, wg.name, wg.slug
     FROM working_group_leaders wgl
     LEFT JOIN slack_user_mappings sm ON wgl.user_id = sm.slack_user_id AND sm.workos_user_id IS NOT NULL
     JOIN working_groups wg ON wg.id = wgl.working_group_id
     WHERE wgl.user_id = $1 OR sm.workos_user_id = $1`,
    [workosUserId]
  );
  const ledCommitteeIds = leaderResult.rows.map(c => c.id);

  if (!isAAOAdmin && ledCommitteeIds.length === 0) {
    return { total: 0, by_committee: {} };
  }

  // Build query for pending content
  let query = `
    SELECT wg.slug as committee_slug, COUNT(*) as count
    FROM perspectives p
    LEFT JOIN working_groups wg ON wg.id = p.working_group_id
    WHERE p.status = 'pending_review'
  `;
  const params: (string | string[])[] = [];

  if (!isAAOAdmin) {
    // Non-admins only see pending for committees they lead
    params.push(ledCommitteeIds);
    query += ` AND p.working_group_id = ANY($${params.length})`;
  }

  query += ` GROUP BY wg.slug`;

  const result = await pool.query<{ committee_slug: string | null; count: string }>(query, params);

  const byCommittee: Record<string, number> = {};
  let total = 0;

  for (const row of result.rows) {
    const key = row.committee_slug || 'personal';
    const count = parseInt(row.count, 10);
    byCommittee[key] = count;
    total += count;
  }

  return { total, by_committee: byCommittee };
}

/**
 * Fetch community profile data for a user.
 * Shared between getMemberContext (Slack) and getWebMemberContext (web chat).
 */
async function fetchCommunityProfile(
  workosUserId: string
): Promise<MemberContext['community_profile'] | undefined> {
  const result = await query<{ is_public: boolean; slug: string | null; completeness: number; github_username: string | null }>(
    `SELECT
      COALESCE(is_public, false) as is_public,
      slug,
      github_username,
      (CASE WHEN headline IS NOT NULL AND headline != '' THEN 1 ELSE 0 END
       + CASE WHEN bio IS NOT NULL AND bio != '' THEN 1 ELSE 0 END
       + CASE WHEN avatar_url IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN expertise IS NOT NULL AND array_length(expertise, 1) > 0 THEN 1 ELSE 0 END
       + CASE WHEN interests IS NOT NULL AND array_length(interests, 1) > 0 THEN 1 ELSE 0 END
       + CASE WHEN city IS NOT NULL AND city != '' THEN 1 ELSE 0 END
       + CASE WHEN linkedin_url IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN github_username IS NOT NULL THEN 1 ELSE 0 END
       + CASE WHEN open_to_coffee_chat = true THEN 1 ELSE 0 END
       + CASE WHEN open_to_intros = true THEN 1 ELSE 0 END
      ) * 10 as completeness
     FROM users WHERE workos_user_id = $1`,
    [workosUserId]
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    is_public: row.is_public,
    slug: row.slug,
    completeness: Number(row.completeness),
    github_username: row.github_username,
  };
}

// Cache for member context to avoid repeated lookups for the same user
// TTL of 30 minutes - user profile data rarely changes, and we invalidate on specific events
const MEMBER_CONTEXT_CACHE_TTL_MS = 30 * 60 * 1000;
const memberContextCache = new Map<string, { context: MemberContext; timestamp: number }>();

/**
 * Get cached member context if still valid
 */
function getCachedContext(slackUserId: string): MemberContext | null {
  const cached = memberContextCache.get(slackUserId);
  if (!cached) return null;

  const age = Date.now() - cached.timestamp;
  if (age > MEMBER_CONTEXT_CACHE_TTL_MS) {
    memberContextCache.delete(slackUserId);
    return null;
  }

  return cached.context;
}

/**
 * Cache member context for future lookups
 */
function setCachedContext(slackUserId: string, context: MemberContext): void {
  memberContextCache.set(slackUserId, { context, timestamp: Date.now() });
}

/**
 * Invalidate cached context for a user (call when user data changes)
 */
export function invalidateMemberContextCache(slackUserId?: string): void {
  if (slackUserId) {
    memberContextCache.delete(slackUserId);
  } else {
    memberContextCache.clear();
  }
}

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
    is_personal: boolean;
  };

  /** Persona classification for the organization */
  persona?: {
    persona: string;
    aspiration_persona: string | null;
    source: string;
    journey_stage: string | null;
  };

  /** Member profile info (if organization has a profile) */
  member_profile?: {
    display_name: string;
    tagline?: string;
    logo_url?: string;
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

  /** Combined conversation activity (Slack + web chat) from addie_threads */
  conversation_activity?: {
    total_messages_30d: number;
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

  /** Community profile status */
  community_profile?: {
    is_public: boolean;
    slug: string | null;
    completeness: number;  // 0-100
    github_username: string | null;
  };

  /** Whether the Slack user is linked to their AgenticAdvertising.org account */
  slack_linked: boolean;

  /** Previous Addie interactions (for web chat only - Slack threads have their own context) */
  addie_history?: {
    total_interactions: number;
    last_interaction_at: Date | null;
    recent_topics: string[];
  };

  /** Pending content the user can review (committee leads and admins) */
  pending_content?: {
    total: number;
    by_committee: Record<string, number>;
  };

  /** Pending join requests for the organization (admins only) */
  pending_join_requests_count?: number;
}

/**
 * Look up member context from a Slack user ID
 *
 * Flow:
 * 1. Check cache for recent lookup
 * 2. Look up Slack user in slack_user_mappings
 * 3. If mapped, get WorkOS user ID
 * 4. Look up user's organization memberships in WorkOS
 * 5. Look up organization and member profile in local DB (in parallel)
 */
export async function getMemberContext(slackUserId: string): Promise<MemberContext> {
  // Check cache first for fast response
  const cached = getCachedContext(slackUserId);
  if (cached) {
    logger.debug({ slackUserId }, 'Addie: Using cached member context');
    return cached;
  }

  const context: MemberContext = {
    is_mapped: false,
    is_member: false,
    slack_linked: false,
  };

  try {
    // Step 1: Look up Slack user (checks DB first, then API with persistence)
    const resolved = await resolveSlackUserDisplayName(slackUserId);

    if (!resolved) {
      logger.debug({ slackUserId }, 'Addie: Could not resolve Slack user');
      return context;
    }

    context.slack_user = {
      slack_user_id: resolved.slack_user_id,
      display_name: resolved.display_name,
      email: resolved.email,
    };

    // Step 2: Check if user is mapped to WorkOS (need full record for workos_user_id)
    const slackMapping = await slackDb.getBySlackUserId(slackUserId);
    if (!slackMapping || !slackMapping.workos_user_id) {
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

    // Steps 5-11: Run all independent lookups in parallel for better performance
    // These queries don't depend on each other, so we can run them concurrently
    // Note: Addie interaction history removed - Slack Assistant threads handle conversation context
    const workosUserId = slackMapping.workos_user_id!; // We've already validated this is not null

    const [
      org,
      profile,
      subscriptionInfo,
      engagement,
      activity,
      userWorkingGroups,
      emailPrefs,
      personaKnowledge,
    ] = await Promise.all([
      // Step 5: Get organization details from local DB
      orgDb.getOrganization(organizationId).catch(error => {
        logger.warn({ error, organizationId }, 'Addie: Failed to get organization');
        return null;
      }),
      // Step 6: Get member profile if exists
      memberDb.getProfileByOrgId(organizationId).catch(error => {
        logger.warn({ error, organizationId }, 'Addie: Failed to get member profile');
        return null;
      }),
      // Step 7: Get subscription details
      orgDb.getSubscriptionInfo(organizationId).catch(error => {
        logger.warn({ error, organizationId }, 'Addie: Failed to get subscription info');
        return null;
      }),
      // Step 8: Get engagement signals for the organization
      orgDb.getEngagementSignals(organizationId).catch(error => {
        logger.warn({ error, organizationId }, 'Addie: Failed to get engagement signals');
        return null;
      }),
      // Step 9: Get Slack activity for the individual user
      slackDb.getActivitySummary(slackUserId, { days: 30 }).catch(error => {
        logger.warn({ error, slackUserId }, 'Addie: Failed to get Slack activity');
        return null;
      }),
      // Step 10: Get working groups for the user
      workingGroupDb.getWorkingGroupsForUser(workosUserId).catch(error => {
        logger.warn({ error, workosUserId }, 'Addie: Failed to get working groups');
        return [];
      }),
      // Step 11: Get email subscription preferences
      emailPrefsDb.getUserPreferencesByUserId(workosUserId).catch(error => {
        logger.warn({ error, workosUserId }, 'Addie: Failed to get email preferences');
        return null;
      }),
      // Step 12: Get persona and journey stage
      orgKnowledgeDb.resolveAttribute(organizationId, 'persona').catch(error => {
        logger.warn({ error, organizationId }, 'Addie: Failed to get persona');
        return null;
      }),
    ]);

    // Process organization details
    if (org) {
      context.organization = {
        workos_organization_id: org.workos_organization_id,
        name: org.name,
        subscription_status: org.subscription_status,
        is_personal: org.is_personal,
      };
      // Only consider them a member if they have an active subscription AND it's not a personal workspace
      context.is_member = org.subscription_status === 'active' && !org.is_personal;
    }

    // Process member profile (only for non-personal workspaces)
    if (profile && !org?.is_personal) {
      context.member_profile = {
        display_name: profile.display_name,
        tagline: profile.tagline,
        logo_url: profile.resolved_brand?.logo_url,
        offerings: profile.offerings,
        headquarters: profile.headquarters,
      };
    }

    // Process subscription info
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

    // Process engagement signals
    if (engagement) {
      context.engagement = {
        login_count_30d: engagement.login_count_30d,
        last_login: engagement.last_login,
        working_group_count: engagement.working_group_count,
        email_click_count_30d: engagement.email_click_count_30d,
        interest_level: engagement.interest_level,
      };
    }

    // Process Slack activity
    if (activity) {
      context.slack_activity = {
        total_messages_30d: activity.total_messages,
        total_reactions_30d: activity.total_reactions,
        total_thread_replies_30d: activity.total_thread_replies,
        active_days_30d: activity.active_days,
        last_activity_at: activity.last_activity_at,
      };
    }

    // Process working groups (need to check leadership in parallel)
    if (userWorkingGroups.length > 0) {
      const workingGroupsWithLeadership = await Promise.all(
        userWorkingGroups.map(async (wg) => ({
          name: wg.name,
          is_leader: await workingGroupDb.isLeader(wg.id, workosUserId).catch(() => false),
        }))
      );
      context.working_groups = workingGroupsWithLeadership;
    }

    // Process email preferences (need to get category prefs if we have user prefs)
    if (emailPrefs) {
      const categoryPrefs = await emailPrefsDb.getUserCategoryPreferences(workosUserId).catch(() => []);
      context.email_status = {
        global_unsubscribed: emailPrefs.global_unsubscribe,
        subscribed_categories: categoryPrefs.filter(c => c.enabled).map(c => c.category_name),
        unsubscribed_categories: categoryPrefs.filter(c => !c.enabled).map(c => c.category_name),
      };
    }

    // Process persona and journey stage
    if (org) {
      try {
        const pool = getPool();
        const personaResult = await pool.query(
          `SELECT persona, aspiration_persona, persona_source, journey_stage
           FROM organizations WHERE workos_organization_id = $1`,
          [organizationId]
        );
        const pRow = personaResult.rows[0];
        if (pRow?.persona) {
          context.persona = {
            persona: pRow.persona,
            aspiration_persona: pRow.aspiration_persona,
            source: pRow.persona_source,
            journey_stage: pRow.journey_stage,
          };
        }
      } catch (error) {
        logger.warn({ error, organizationId }, 'Addie: Failed to get persona data');
      }
    }

    // Community profile
    try {
      context.community_profile = await fetchCommunityProfile(workosUserId);
    } catch (err) {
      // Non-critical - community profile columns may not exist yet
    }

    // Get pending content for committee leads and AAO admins
    const ledCommitteeIds = context.working_groups
      ?.filter(wg => wg.is_leader)
      .map(wg => wg.name) || [];

    // Check AAO admin status (aao-admin working group membership)
    const adminGroup = await workingGroupDb.getWorkingGroupBySlug('aao-admin');
    const isAAOAdmin = adminGroup ? await workingGroupDb.isMember(adminGroup.id, workosUserId) : false;

    if (ledCommitteeIds.length > 0 || isAAOAdmin) {
      try {
        const pendingContent = await getPendingContentForUser(workosUserId, isAAOAdmin);
        if (pendingContent.total > 0) {
          context.pending_content = pendingContent;
        }
      } catch (error) {
        logger.warn({ error, workosUserId }, 'Addie: Failed to get pending content');
      }
    }

    // Get pending join requests count for org admins (WorkOS org role - admin within their company)
    const isOrgAdmin = context.org_membership?.role === 'admin';
    if (isOrgAdmin && organizationId) {
      try {
        const pendingJoinRequestsCount = await joinRequestDb.getPendingRequestCount(organizationId);
        if (pendingJoinRequestsCount > 0) {
          context.pending_join_requests_count = pendingJoinRequestsCount;
        }
      } catch (error) {
        logger.warn({ error, organizationId }, 'Addie: Failed to get pending join requests count');
      }
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

    // Cache the context for future lookups
    setCachedContext(slackUserId, context);

    return context;
  } catch (error) {
    logger.error({ error, slackUserId }, 'Addie: Error getting member context');
    return context;
  }
}

/**
 * Look up member context from a WorkOS user ID (for web chat)
 *
 * Similar to getMemberContext() but starts from WorkOS user ID instead of Slack user ID.
 * Used when user is authenticated via web session rather than Slack.
 */
export async function getWebMemberContext(workosUserId: string): Promise<MemberContext> {
  const context: MemberContext = {
    is_mapped: true, // They're authenticated via WorkOS, so they're "mapped"
    is_member: false,
    slack_linked: false,
  };

  try {
    // Step 1: Get WorkOS user info
    let workosUser;
    try {
      workosUser = await workos.userManagement.getUser(workosUserId);
      context.workos_user = {
        workos_user_id: workosUser.id,
        email: workosUser.email,
        first_name: workosUser.firstName ?? undefined,
        last_name: workosUser.lastName ?? undefined,
      };
    } catch (error) {
      logger.warn({ error, workosUserId }, 'Addie Web: Failed to get WorkOS user');
      return context;
    }

    // Step 2: Check if user has a Slack mapping (for slack_linked status)
    try {
      const slackMapping = await slackDb.getByWorkosUserId(workosUserId);
      if (slackMapping) {
        context.slack_linked = true;
        context.slack_user = {
          slack_user_id: slackMapping.slack_user_id,
          display_name: slackMapping.slack_display_name || slackMapping.slack_real_name,
          email: slackMapping.slack_email,
        };

        // Get Slack activity if linked
        try {
          const activity = await slackDb.getActivitySummary(slackMapping.slack_user_id, { days: 30 });
          context.slack_activity = {
            total_messages_30d: activity.total_messages,
            total_reactions_30d: activity.total_reactions,
            total_thread_replies_30d: activity.total_thread_replies,
            active_days_30d: activity.active_days,
            last_activity_at: activity.last_activity_at,
          };
        } catch (error) {
          logger.warn({ error, workosUserId }, 'Addie Web: Failed to get Slack activity');
        }
      }
    } catch (error) {
      logger.warn({ error, workosUserId }, 'Addie Web: Failed to check Slack mapping');
    }

    // Step 3: Get user's organization memberships
    let organizationId: string | null = null;
    let userRole: string = 'member';
    let userJoinedAt: Date | null = null;
    try {
      const memberships = await workos.userManagement.listOrganizationMemberships({
        userId: workosUserId,
      });

      if (memberships.data && memberships.data.length > 0) {
        const membership = memberships.data[0];
        organizationId = membership.organizationId;
        userRole = membership.role?.slug || 'member';
        userJoinedAt = membership.createdAt ? new Date(membership.createdAt) : null;
      }
    } catch (error) {
      logger.warn({ error, workosUserId }, 'Addie Web: Failed to get org memberships');
      return context;
    }

    if (!organizationId) {
      logger.debug({ workosUserId }, 'Addie Web: User has no organization');
      return context;
    }

    // Step 4: Get org member count from WorkOS
    let memberCount = 0;
    try {
      const orgMemberships = await workos.userManagement.listOrganizationMemberships({
        organizationId: organizationId,
      });
      memberCount = orgMemberships.data?.length || 0;
    } catch (error) {
      logger.warn({ error, organizationId }, 'Addie Web: Failed to get org member count');
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
        is_personal: org.is_personal,
      };
      // Only consider them a member if they have an active subscription AND it's not a personal workspace
      context.is_member = org.subscription_status === 'active' && !org.is_personal;
    }

    // Step 6: Get member profile if exists (only for non-personal workspaces)
    const profile = await memberDb.getProfileByOrgId(organizationId);
    if (profile && !org?.is_personal) {
      context.member_profile = {
        display_name: profile.display_name,
        tagline: profile.tagline,
        logo_url: profile.resolved_brand?.logo_url,
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
      logger.warn({ error, organizationId }, 'Addie Web: Failed to get subscription info');
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
      logger.warn({ error, organizationId }, 'Addie Web: Failed to get engagement signals');
    }

    // Step 9: Get working groups for the user
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
      logger.warn({ error, workosUserId }, 'Addie Web: Failed to get working groups');
    }

    // Step 10: Get email subscription preferences
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
      logger.warn({ error, workosUserId }, 'Addie Web: Failed to get email preferences');
    }

    // Get persona and journey stage
    if (org) {
      try {
        const pool = getPool();
        const personaResult = await pool.query(
          `SELECT persona, aspiration_persona, persona_source, journey_stage
           FROM organizations WHERE workos_organization_id = $1`,
          [organizationId]
        );
        const pRow = personaResult.rows[0];
        if (pRow?.persona) {
          context.persona = {
            persona: pRow.persona,
            aspiration_persona: pRow.aspiration_persona,
            source: pRow.persona_source,
            journey_stage: pRow.journey_stage,
          };
        }
      } catch (error) {
        logger.warn({ error, organizationId }, 'Addie Web: Failed to get persona data');
      }
    }

    // Community profile
    try {
      context.community_profile = await fetchCommunityProfile(workosUserId);
    } catch (error) {
      logger.warn({ error, workosUserId }, 'Addie Web: Failed to get community profile');
    }

    // Step 11: Get combined conversation activity (Slack + web chat) from addie_threads
    try {
      const threadService = getThreadService();
      const conversationActivity = await threadService.getUserActivityStats(workosUserId, 'workos', 30);
      if (conversationActivity.total_messages > 0 || conversationActivity.active_days > 0) {
        context.conversation_activity = {
          total_messages_30d: conversationActivity.total_messages,
          active_days_30d: conversationActivity.active_days,
          last_activity_at: conversationActivity.last_activity_at,
        };
      }
    } catch (error) {
      logger.warn({ error, workosUserId }, 'Addie Web: Failed to get conversation activity');
    }

    // Step 12: Get Addie interaction history
    // For web users, we'd need to query addie_conversations table by user_id (WorkOS ID)
    // For now, if they have a Slack mapping, we can get their Slack interactions
    if (context.slack_user?.slack_user_id) {
      try {
        const interactions = await addieDb.getInteractions({ userId: context.slack_user.slack_user_id, limit: 10 });
        if (interactions.length > 0) {
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
        logger.warn({ error, workosUserId }, 'Addie Web: Failed to get Addie interaction history');
      }
    }

    // Step 13: Get pending content for committee leads and AAO admins
    const leadsCommittees = context.working_groups?.filter(wg => wg.is_leader) || [];

    // Check AAO admin status (aao-admin working group membership)
    const webAdminGroup = await workingGroupDb.getWorkingGroupBySlug('aao-admin');
    const webIsAAOAdmin = webAdminGroup ? await workingGroupDb.isMember(webAdminGroup.id, workosUserId) : false;

    if (leadsCommittees.length > 0 || webIsAAOAdmin) {
      try {
        const pendingContent = await getPendingContentForUser(workosUserId, webIsAAOAdmin);
        if (pendingContent.total > 0) {
          context.pending_content = pendingContent;
        }
      } catch (error) {
        logger.warn({ error, workosUserId }, 'Addie Web: Failed to get pending content');
      }
    }

    // Step 14: Get pending join requests count for org admins (WorkOS org role - admin within their company)
    const webIsOrgAdmin = context.org_membership?.role === 'admin';
    if (webIsOrgAdmin && organizationId) {
      try {
        const pendingJoinRequestsCount = await joinRequestDb.getPendingRequestCount(organizationId);
        if (pendingJoinRequestsCount > 0) {
          context.pending_join_requests_count = pendingJoinRequestsCount;
        }
      } catch (error) {
        logger.warn({ error, organizationId }, 'Addie Web: Failed to get pending join requests count');
      }
    }

    logger.debug(
      {
        workosUserId,
        isMapped: context.is_mapped,
        isMember: context.is_member,
        slackLinked: context.slack_linked,
        orgName: context.organization?.name,
      },
      'Addie Web: Member context resolved'
    );

    return context;
  } catch (error) {
    logger.error({ error, workosUserId }, 'Addie Web: Error getting member context');
    return context;
  }
}

export function formatMemberContextForPrompt(context: MemberContext, channel: 'web' | 'slack' = 'slack'): string | null {
  const lines: string[] = [];
  lines.push('## User Context');

  // Channel indicator - critical for Addie to know how to respond
  lines.push(`**Channel**: ${channel}`);

  // If user is not authenticated at all
  if (!context.is_mapped) {
    if (channel === 'web') {
      lines.push('**Status**: Anonymous user (not signed in)');
      lines.push('');
      lines.push('This user is browsing the web chat without signing in.');
      lines.push('');
      return lines.join('\n');
    }
    // For Slack, no context means we can't identify them
    return null;
  }

  // User name
  const userName =
    context.workos_user?.first_name ||
    context.slack_user?.display_name ||
    'Unknown';
  lines.push(`The user's name is ${userName}.`);

  // Organization
  if (context.organization) {
    if (context.organization.is_personal) {
      lines.push('They have an individual account (not a company account).');
      if (context.is_member) {
        lines.push('They are an active AgenticAdvertising.org individual member.');
      } else {
        lines.push('They are not currently an AgenticAdvertising.org member.');
      }
    } else {
      lines.push(`They work at ${context.organization.name}.`);

      if (context.is_member) {
        lines.push('Their organization is an active AgenticAdvertising.org member.');
      } else {
        lines.push('Their organization is not currently an AgenticAdvertising.org member.');
      }
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

  // Persona and journey stage
  lines.push('');
  lines.push('### Organization Persona');
  if (context.persona) {
    lines.push(`Persona: ${PERSONA_LABELS[context.persona.persona] || context.persona.persona}`);
    if (context.persona.aspiration_persona) {
      lines.push(`Aspiration: ${PERSONA_LABELS[context.persona.aspiration_persona] || context.persona.aspiration_persona}`);
    }
    if (context.persona.journey_stage) {
      lines.push(`Journey stage: ${context.persona.journey_stage}`);
    }
    lines.push(`Classification source: ${context.persona.source}`);
    if (context.persona.source !== 'diagnostic') {
      lines.push('Note: Persona was inferred, not self-reported. The user has not completed the organization type assessment.');
      lines.push('If it comes up naturally, suggest they discover their agentic archetype: https://agenticadvertising.org/persona-assessment');
    }
  } else {
    lines.push('Persona: Not set — the user has not completed the organization type assessment.');
    lines.push('If it comes up naturally, suggest they discover their agentic archetype: https://agenticadvertising.org/persona-assessment');
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

  // Community profile status
  if (context.community_profile) {
    if (context.community_profile.is_public) {
      lines.push('');
      lines.push(`Community profile: Public (${context.community_profile.completeness}% complete) — https://agenticadvertising.org/community/people/${context.community_profile.slug}`);
    } else {
      lines.push('');
      lines.push('Community profile: Not yet public. Encourage them to visit https://agenticadvertising.org/community to set up their profile and join the people directory.');
    }
    if (context.community_profile.github_username) {
      lines.push(`GitHub: ${context.community_profile.github_username}`);
    } else {
      lines.push('GitHub: Not linked. If they mention GitHub repos or issues, suggest linking their GitHub username at https://agenticadvertising.org/community/profile/edit to make it visible on their community profile.');
    }
  }

  // Slack linking status
  if (!context.slack_linked) {
    lines.push('');
    lines.push('Note: This user\'s Slack account is not yet linked to their AgenticAdvertising.org account.');
  }

  // Pending content notifications (for committee leads and admins)
  if (context.pending_content && context.pending_content.total > 0) {
    lines.push('');
    lines.push('### Action Required: Pending Content');
    lines.push(`There are ${context.pending_content.total} content item(s) awaiting your review.`);
    for (const [committee, count] of Object.entries(context.pending_content.by_committee)) {
      const label = committee === 'personal' ? 'Personal perspectives' : committee;
      lines.push(`- ${label}: ${count}`);
    }
    lines.push('');
    lines.push('IMPORTANT: Proactively mention this pending content to the user. Use `list_pending_content` to show details when relevant, or if the user asks about pending items.');
  }

  // Note: Previous Addie interactions removed - Slack Assistant threads handle conversation context automatically

  lines.push('');
  lines.push('Use this context to personalize your response when relevant.');
  lines.push('');

  return lines.join('\n');
}
