/**
 * User journey computation
 *
 * Assembles individual journey data from existing tables:
 * community_points, learner_progress, user_credentials,
 * working_group_memberships, working_group_leaders, perspectives.
 *
 * No new tables needed — all data already exists.
 */

import { query } from '../db/client.js';
import { getTrackProgress, getUserCredentials, getProgress } from '../db/certification-db.js';
import { createLogger } from '../logger.js';

const logger = createLogger('user-journey');

// Tier thresholds (spec-defined)
export const TIER_THRESHOLDS = [
  { tier: 'pioneer', min: 500 },
  { tier: 'champion', min: 200 },
  { tier: 'connector', min: 50 },
  { tier: 'explorer', min: 0 },
] as const;

export type TierName = typeof TIER_THRESHOLDS[number]['tier'];

export interface UserTier {
  tier: TierName;
  points: number;
  next_tier: TierName | null;
  next_tier_at: number | null;
  progress_pct: number; // 0-100 progress toward next tier
}

export interface PointBreakdown {
  action: string;
  points: number;
  reference_id: string | null;
  reference_type: string | null;
  created_at: string;
}

export interface JourneyCertification {
  credentials: Array<{
    credential_id: string;
    name: string;
    tier: number;
    awarded_at: string;
  }>;
  current_track: {
    track_id: string;
    modules_completed: number;
    modules_total: number;
    in_progress_modules: number;
  } | null;
  modules_completed: number;
}

export interface JourneyWorkingGroup {
  id: string;
  name: string;
  slug: string;
  joined_at: string;
  is_leader: boolean;
}

export interface JourneyContribution {
  id: string;
  title: string;
  content_type: string;
  status: string;
  created_at: string;
}

export interface JourneyCommunity {
  profile_completeness: number;
  member_since: string;
  last_active: string | null;
  connections_count: number;
}

export interface NextStep {
  action: string;
  label: string;
  url: string;
  context?: string;
}

export interface RecentMilestone {
  type: 'credential_earned' | 'tier_reached' | 'first_contribution' | 'group_leadership';
  label: string;
  detail: string;
  occurred_at: string;
}

export interface CommunityStats {
  credentials_earned_30d: number;
  perspectives_published_30d: number;
  new_members_30d: number;
}

export interface WhatChanged {
  days_away: number;
  new_credentials_community: number;
  new_perspectives: number;
  new_working_groups: number;
}

export interface UserJourney {
  tier: UserTier;
  points_breakdown: PointBreakdown[];
  certification: JourneyCertification;
  working_groups: JourneyWorkingGroup[];
  contributions: JourneyContribution[];
  community: JourneyCommunity;
  suggested_next_steps: NextStep[];
  recent_milestone: RecentMilestone | null;
  community_stats: CommunityStats;
  what_changed: WhatChanged | null;
  org_context: {
    org_name: string;
    certified_count: number;
    certified_total: number;
  } | null;
}

export function computeUserTier(points: number): UserTier {
  let currentIdx = TIER_THRESHOLDS.findIndex(t => points >= t.min);
  if (currentIdx === -1) currentIdx = TIER_THRESHOLDS.length - 1;

  const current = TIER_THRESHOLDS[currentIdx];
  const next = currentIdx > 0 ? TIER_THRESHOLDS[currentIdx - 1] : null;

  let progressPct = 100;
  if (next) {
    const range = next.min - current.min;
    const earned = points - current.min;
    progressPct = Math.min(100, Math.round((earned / range) * 100));
  }

  return {
    tier: current.tier,
    points,
    next_tier: next?.tier ?? null,
    next_tier_at: next?.min ?? null,
    progress_pct: progressPct,
  };
}

export function computeNextSteps(data: {
  credentials: Array<{ credential_id: string }>;
  modulesCompleted: number;
  workingGroupCount: number;
  contributionCount: number;
  profileCompleteness: number;
  hasInProgressModule: boolean;
}): NextStep[] {
  const steps: NextStep[] = [];

  // Certification first — highest activation value
  if (data.modulesCompleted === 0 && !data.hasInProgressModule) {
    steps.push({
      action: 'start_certification',
      label: 'Start your foundations certification',
      url: '/certification',
      context: 'The fastest way to get oriented in the protocol',
    });
  } else if (data.hasInProgressModule) {
    steps.push({
      action: 'continue_certification',
      label: 'Continue your certification',
      url: '/certification',
      context: 'Pick up where you left off',
    });
  }

  if (data.workingGroupCount === 0) {
    steps.push({
      action: 'join_working_group',
      label: 'Join a working group',
      url: '/committees?type=working_group',
      context: 'Where the real work happens',
    });
  }

  // Profile completion after higher-value actions
  if (data.profileCompleteness < 80) {
    steps.push({
      action: 'complete_profile',
      label: 'Complete your profile',
      url: '/community/profile/edit',
      context: `${data.profileCompleteness}% complete`,
    });
  }

  if (data.contributionCount === 0 && data.modulesCompleted > 0) {
    steps.push({
      action: 'share_perspective',
      label: 'Share a perspective',
      url: '/my-content',
      context: 'Contribute what you know to the community',
    });
  }

  // Advanced users: never return empty
  if (steps.length === 0) {
    if (data.workingGroupCount === 1) {
      steps.push({
        action: 'second_working_group',
        label: 'Join another working group',
        url: '/committees?type=working_group',
        context: 'Broaden your involvement across the community',
      });
    }
    if (data.credentials.length > 0 && !data.hasInProgressModule) {
      steps.push({
        action: 'next_certification_tier',
        label: 'Earn your next credential',
        url: '/certification',
        context: 'Keep building your expertise',
      });
    }
    if (steps.length === 0) {
      steps.push({
        action: 'connect_with_peers',
        label: 'Connect with other members',
        url: '/community/people',
        context: 'Grow your professional network',
      });
    }
  }

  // Return top 2 most relevant
  return steps.slice(0, 2);
}

async function computeWhatChanged(userId: string, lastActive: string | null): Promise<WhatChanged | null> {
  if (!lastActive) return null;

  const lastDate = new Date(lastActive);
  const now = new Date();
  const daysAway = Math.floor((now.getTime() - lastDate.getTime()) / 86400000);
  if (daysAway < 14) return null;

  // Cap the lookup window at 30 days to avoid noise ("847 credentials earned")
  const lookbackDate = daysAway > 30
    ? new Date(now.getTime() - 30 * 86400000)
    : lastDate;

  try {
    const result = await query<{
      new_credentials: string;
      new_perspectives: string;
      new_groups: string;
    }>(
      `SELECT
         (SELECT COUNT(*) FROM user_credentials
          WHERE awarded_at > $1) as new_credentials,
         (SELECT COUNT(*) FROM perspectives
          WHERE status = 'published'
            AND COALESCE(published_at, created_at) > $1) as new_perspectives,
         (SELECT COUNT(*) FROM working_groups
          WHERE created_at > $1) as new_groups`,
      [lookbackDate.toISOString()]
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      days_away: daysAway,
      new_credentials_community: parseInt(row.new_credentials, 10),
      new_perspectives: parseInt(row.new_perspectives, 10),
      new_working_groups: parseInt(row.new_groups, 10),
    };
  } catch (err) {
    logger.error({ err, userId }, 'Failed to compute what changed');
    return null;
  }
}

export async function assembleUserJourney(userId: string): Promise<UserJourney> {
  const [
    pointsTotal,
    pointsBreakdown,
    credentials,
    trackProgress,
    learnerProgress,
    workingGroups,
    contributions,
    communityData,
    orgContext,
    recentCredential,
    communityStats,
  ] = await Promise.all([
    // Total points
    query<{ total: string }>(
      `SELECT COALESCE(SUM(points), 0) as total FROM community_points WHERE workos_user_id = $1`,
      [userId]
    ).then(r => parseInt(r.rows[0]?.total || '0', 10)).catch(err => {
      logger.error({ err, userId }, 'Failed to fetch points total');
      return 0;
    }),

    // Points breakdown (recent 50)
    query<PointBreakdown>(
      `SELECT action, points, reference_id, reference_type, created_at
       FROM community_points WHERE workos_user_id = $1
       ORDER BY created_at DESC LIMIT 50`,
      [userId]
    ).then(r => r.rows).catch(err => {
      logger.error({ err, userId }, 'Failed to fetch points breakdown');
      return [];
    }),

    // Credentials
    query<{ credential_id: string; name: string; tier: number; awarded_at: string }>(
      `SELECT uc.credential_id, cc.name, cc.tier, uc.awarded_at
       FROM user_credentials uc
       JOIN certification_credentials cc ON cc.id = uc.credential_id
       WHERE uc.workos_user_id = $1
       ORDER BY cc.tier, cc.sort_order`,
      [userId]
    ).then(r => r.rows).catch(err => {
      logger.error({ err, userId }, 'Failed to fetch credentials');
      return [];
    }),

    // Track progress
    getTrackProgress(userId).catch(err => {
      logger.error({ err, userId }, 'Failed to fetch track progress');
      return [];
    }),

    // Learner progress (for in-progress detection)
    getProgress(userId).catch(err => {
      logger.error({ err, userId }, 'Failed to fetch learner progress');
      return [];
    }),

    // Working groups with leader status
    query<JourneyWorkingGroup>(
      `SELECT wg.id, wg.name, wg.slug, wgm.joined_at,
              EXISTS(
                SELECT 1 FROM working_group_leaders wgl
                LEFT JOIN slack_user_mappings sm ON sm.slack_user_id = wgl.user_id
                WHERE wgl.working_group_id = wg.id
                  AND (wgl.user_id = $1 OR sm.workos_user_id = $1)
              ) as is_leader
       FROM working_groups wg
       JOIN working_group_memberships wgm ON wgm.working_group_id = wg.id
       WHERE wgm.workos_user_id = $1 AND wgm.status = 'active'
       ORDER BY wg.name`,
      [userId]
    ).then(r => r.rows).catch(err => {
      logger.error({ err, userId }, 'Failed to fetch working groups');
      return [];
    }),

    // Content contributions
    query<JourneyContribution>(
      `SELECT DISTINCT p.id, p.title, p.content_type, p.status, p.created_at
       FROM perspectives p
       LEFT JOIN content_authors ca ON ca.perspective_id = p.id
       WHERE p.author_user_id = $1 OR p.proposer_user_id = $1 OR ca.user_id = $1
       ORDER BY p.created_at DESC LIMIT 20`,
      [userId]
    ).then(r => r.rows).catch(err => {
      logger.error({ err, userId }, 'Failed to fetch contributions');
      return [];
    }),

    // Community data (profile completeness, member_since, connections)
    query<{
      headline: string | null;
      bio: string | null;
      avatar_url: string | null;
      expertise: string[] | null;
      interests: string[] | null;
      city: string | null;
      linkedin_url: string | null;
      github_username: string | null;
      open_to_coffee_chat: boolean;
      open_to_intros: boolean;
      created_at: string;
      connection_count: string;
      last_active: string | null;
    }>(
      `SELECT u.headline, u.bio, u.avatar_url, u.expertise, u.interests,
              u.city, u.linkedin_url, u.github_username,
              u.open_to_coffee_chat, u.open_to_intros,
              u.created_at,
              (SELECT COUNT(*) FROM connections
               WHERE (requester_user_id = $1 OR recipient_user_id = $1)
                 AND status = 'accepted') as connection_count,
              (SELECT MAX(created_at) FROM community_points
               WHERE workos_user_id = $1) as last_active
       FROM users u WHERE u.workos_user_id = $1`,
      [userId]
    ).then(r => r.rows[0] ?? null).catch(err => {
      logger.error({ err, userId }, 'Failed to fetch community data');
      return null;
    }),

    // Org context (for "You're one of N certified at Company")
    query<{ org_name: string; certified_count: string; certified_total: string }>(
      `SELECT o.name as org_name,
              (SELECT COUNT(DISTINCT uc.workos_user_id)
               FROM organization_memberships om2
               JOIN user_credentials uc ON uc.workos_user_id = om2.workos_user_id
               WHERE om2.workos_organization_id = om.workos_organization_id) as certified_count,
              (SELECT COUNT(*) FROM organization_memberships om3
               WHERE om3.workos_organization_id = om.workos_organization_id) as certified_total
       FROM organization_memberships om
       JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
       WHERE om.workos_user_id = $1 AND o.is_personal = false
       ORDER BY om.workos_organization_id
       LIMIT 1`,
      [userId]
    ).then(r => r.rows[0] ?? null).catch(err => {
      logger.error({ err, userId }, 'Failed to fetch org context');
      return null;
    }),

    // Most recent credential (for milestone celebration, last 7 days)
    query<{ name: string; awarded_at: string }>(
      `SELECT cc.name, uc.awarded_at
       FROM user_credentials uc
       JOIN certification_credentials cc ON cc.id = uc.credential_id
       WHERE uc.workos_user_id = $1
         AND uc.awarded_at > NOW() - INTERVAL '7 days'
       ORDER BY uc.awarded_at DESC LIMIT 1`,
      [userId]
    ).then(r => r.rows[0] ?? null).catch(err => {
      logger.error({ err, userId }, 'Failed to fetch recent credential');
      return null;
    }),

    // Community-wide stats (last 30 days)
    query<{ credentials_earned: string; perspectives_published: string; new_members: string }>(
      `SELECT
         (SELECT COUNT(*) FROM user_credentials
          WHERE awarded_at > NOW() - INTERVAL '30 days') as credentials_earned,
         (SELECT COUNT(*) FROM perspectives
          WHERE status = 'published'
            AND COALESCE(published_at, created_at) > NOW() - INTERVAL '30 days') as perspectives_published,
         (SELECT COUNT(*) FROM users
          WHERE created_at > NOW() - INTERVAL '30 days') as new_members`,
      []
    ).then(r => r.rows[0] ?? null).catch(err => {
      logger.error({ err, userId }, 'Failed to fetch community stats');
      return null;
    }),
  ]);

  // Compute profile completeness (booleans count as filled even if false — they're preferences, not missing data)
  let profileFilled = 0;
  if (communityData) {
    if (communityData.headline) profileFilled++;
    if (communityData.bio) profileFilled++;
    if (communityData.avatar_url) profileFilled++;
    if (communityData.expertise?.length) profileFilled++;
    if (communityData.interests?.length) profileFilled++;
    if (communityData.city) profileFilled++;
    if (communityData.linkedin_url) profileFilled++;
    if (communityData.github_username) profileFilled++;
    if (communityData.open_to_coffee_chat !== null && communityData.open_to_coffee_chat !== undefined) profileFilled++;
    if (communityData.open_to_intros !== null && communityData.open_to_intros !== undefined) profileFilled++;
  }
  const profileCompleteness = Math.round((profileFilled / 10) * 100);

  // Find current track (the one with in-progress modules, or most complete)
  const activeTrack = trackProgress.find(t => t.in_progress_modules > 0)
    || trackProgress.find(t => t.completed_modules > 0 && t.completed_modules < t.total_modules)
    || null;

  const modulesCompleted = learnerProgress.filter(
    p => p.status === 'completed' || p.status === 'tested_out'
  ).length;

  const hasInProgressModule = learnerProgress.some(p => p.status === 'in_progress');

  const tier = computeUserTier(pointsTotal);

  const nextSteps = computeNextSteps({
    credentials,
    modulesCompleted,
    workingGroupCount: workingGroups.length,
    contributionCount: contributions.filter(c => c.status === 'published').length,
    profileCompleteness,
    hasInProgressModule,
  });

  return {
    tier,
    points_breakdown: pointsBreakdown,
    certification: {
      credentials,
      current_track: activeTrack ? {
        track_id: activeTrack.track_id,
        modules_completed: activeTrack.completed_modules,
        modules_total: activeTrack.total_modules,
        in_progress_modules: activeTrack.in_progress_modules,
      } : null,
      modules_completed: modulesCompleted,
    },
    working_groups: workingGroups,
    contributions,
    community: {
      profile_completeness: profileCompleteness,
      member_since: communityData?.created_at ?? new Date().toISOString(),
      last_active: communityData?.last_active ?? null,
      connections_count: parseInt(communityData?.connection_count ?? '0', 10),
    },
    suggested_next_steps: nextSteps,
    recent_milestone: recentCredential ? {
      type: 'credential_earned',
      label: `You earned ${recentCredential.name}`,
      detail: 'Share your achievement with your network',
      occurred_at: recentCredential.awarded_at,
    } : null,
    community_stats: {
      credentials_earned_30d: parseInt(communityStats?.credentials_earned ?? '0', 10),
      perspectives_published_30d: parseInt(communityStats?.perspectives_published ?? '0', 10),
      new_members_30d: parseInt(communityStats?.new_members ?? '0', 10),
    },
    what_changed: await computeWhatChanged(userId, communityData?.last_active ?? null),
    org_context: orgContext ? {
      org_name: orgContext.org_name,
      certified_count: parseInt(orgContext.certified_count, 10),
      certified_total: parseInt(orgContext.certified_total, 10),
    } : null,
  };
}
