import { query } from './client.js';
import type { MemberCapabilities } from '../addie/types.js';

/**
 * Get member capabilities - what features have they used/not used?
 * This helps the planner identify which capabilities to suggest.
 */
export async function getMemberCapabilities(
  slackUserId: string,
  workosUserId?: string
): Promise<MemberCapabilities> {
  // Default capabilities for unmapped users
  if (!workosUserId) {
    return {
      account_linked: false,
      profile_complete: false,
      offerings_set: false,
      email_prefs_configured: false,
      has_team_members: false,
      is_org_admin: false,
      working_group_count: 0,
      council_count: 0,
      events_registered: 0,
      events_attended: 0,
      community_profile_public: false,
      community_profile_completeness: 0,
      last_active_days_ago: null,
      slack_message_count_30d: 0,
      is_committee_leader: false,
    };
  }

  // Query all capability states in parallel
  const [
    profileResult,
    teamResult,
    workingGroupResult,
    eventResult,
    activityResult,
    emailPrefsResult,
    leaderResult,
    communityResult,
  ] = await Promise.all([
    // Profile completeness
    query<{
      has_profile: boolean;
      offerings_count: number;
    }>(
      `SELECT
        EXISTS(SELECT 1 FROM member_profiles mp
               JOIN organization_memberships om ON om.workos_organization_id = mp.workos_organization_id
               WHERE om.workos_user_id = $1
               AND mp.display_name IS NOT NULL
               AND mp.description IS NOT NULL) as has_profile,
        COALESCE((SELECT array_length(mp.offerings, 1) FROM member_profiles mp
                  JOIN organization_memberships om ON om.workos_organization_id = mp.workos_organization_id
                  WHERE om.workos_user_id = $1), 0) as offerings_count`,
      [workosUserId]
    ),

    // Team members
    query<{
      team_count: number;
      is_admin: boolean;
    }>(
      `SELECT
        (SELECT COUNT(*) FROM organization_memberships om2
         WHERE om2.workos_organization_id = om.workos_organization_id
         AND om2.workos_user_id != $1) as team_count,
        EXISTS(SELECT 1 FROM organizations o
               JOIN organization_memberships om3 ON om3.workos_organization_id = o.workos_organization_id
               WHERE om3.workos_user_id = $1) as is_admin
       FROM organization_memberships om
       WHERE om.workos_user_id = $1
       LIMIT 1`,
      [workosUserId]
    ),

    // Working groups & councils (include leaders as implicit members)
    query<{
      wg_count: number;
      council_count: number;
    }>(
      `SELECT
        (SELECT COUNT(DISTINCT wg.id) FROM working_groups wg
         WHERE wg.committee_type = 'working_group'
         AND (
           EXISTS(SELECT 1 FROM working_group_memberships wgm WHERE wgm.working_group_id = wg.id AND wgm.workos_user_id = $1)
           OR EXISTS(SELECT 1 FROM working_group_leaders wgl
                     LEFT JOIN slack_user_mappings sm ON wgl.user_id = sm.slack_user_id AND sm.workos_user_id IS NOT NULL
                     WHERE wgl.working_group_id = wg.id AND (wgl.user_id = $1 OR sm.workos_user_id = $1))
         )) as wg_count,
        (SELECT COUNT(DISTINCT wg.id) FROM working_groups wg
         WHERE wg.committee_type = 'council'
         AND (
           EXISTS(SELECT 1 FROM working_group_memberships wgm WHERE wgm.working_group_id = wg.id AND wgm.workos_user_id = $1)
           OR EXISTS(SELECT 1 FROM working_group_leaders wgl
                     LEFT JOIN slack_user_mappings sm ON wgl.user_id = sm.slack_user_id AND sm.workos_user_id IS NOT NULL
                     WHERE wgl.working_group_id = wg.id AND (wgl.user_id = $1 OR sm.workos_user_id = $1))
         )) as council_count`,
      [workosUserId]
    ),

    // Events
    query<{
      registered: number;
      attended: number;
    }>(
      `SELECT
        (SELECT COUNT(*) FROM event_registrations er WHERE er.workos_user_id = $1) as registered,
        (SELECT COUNT(*) FROM event_registrations er WHERE er.workos_user_id = $1 AND er.checked_in_at IS NOT NULL) as attended`,
      [workosUserId]
    ),

    // Recent activity
    query<{
      last_active_days: number | null;
      slack_messages_30d: number;
    }>(
      `SELECT
        EXTRACT(DAY FROM NOW() - COALESCE(
          (SELECT last_slack_activity_at FROM slack_user_mappings WHERE workos_user_id = $1),
          (SELECT created_at FROM slack_user_mappings WHERE workos_user_id = $1)
        )) as last_active_days,
        COALESCE((SELECT SUM(message_count) FROM slack_activity_daily
                  WHERE slack_user_id = (SELECT slack_user_id FROM slack_user_mappings WHERE workos_user_id = $1)
                  AND activity_date > NOW() - INTERVAL '30 days'), 0) as slack_messages_30d`,
      [workosUserId]
    ),

    // Email preferences
    query<{ configured: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM user_email_preferences WHERE workos_user_id = $1) as configured`,
      [workosUserId]
    ),

    // Leadership
    query<{ is_leader: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM working_group_leaders WHERE user_id = $1) as is_leader`,
      [workosUserId]
    ),

    // Community profile
    query<{ is_public: boolean; completeness_fields: number }>(
      `SELECT
        COALESCE(u.is_public, false) as is_public,
        (CASE WHEN u.headline IS NOT NULL AND u.headline != '' THEN 1 ELSE 0 END
         + CASE WHEN u.bio IS NOT NULL AND u.bio != '' THEN 1 ELSE 0 END
         + CASE WHEN u.avatar_url IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN u.expertise IS NOT NULL AND array_length(u.expertise, 1) > 0 THEN 1 ELSE 0 END
         + CASE WHEN u.interests IS NOT NULL AND array_length(u.interests, 1) > 0 THEN 1 ELSE 0 END
         + CASE WHEN u.city IS NOT NULL AND u.city != '' THEN 1 ELSE 0 END
         + CASE WHEN u.linkedin_url IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN u.github_username IS NOT NULL THEN 1 ELSE 0 END
         + CASE WHEN u.open_to_coffee_chat = true THEN 1 ELSE 0 END
         + CASE WHEN u.open_to_intros = true THEN 1 ELSE 0 END
        ) as completeness_fields
       FROM users u WHERE u.workos_user_id = $1`,
      [workosUserId]
    ),
  ]);

  const profile = profileResult.rows[0] ?? { has_profile: false, offerings_count: 0 };
  const team = teamResult.rows[0] ?? { team_count: 0, is_admin: false };
  const wg = workingGroupResult.rows[0] ?? { wg_count: 0, council_count: 0 };
  const events = eventResult.rows[0] ?? { registered: 0, attended: 0 };
  const activity = activityResult.rows[0] ?? { last_active_days: null, slack_messages_30d: 0 };
  const emailPrefs = emailPrefsResult.rows[0] ?? { configured: false };
  const leader = leaderResult.rows[0] ?? { is_leader: false };
  const community = communityResult.rows[0] ?? { is_public: false, completeness_fields: 0 };

  return {
    account_linked: true,
    profile_complete: profile.has_profile,
    offerings_set: profile.offerings_count > 0,
    email_prefs_configured: emailPrefs.configured,
    has_team_members: Number(team.team_count) > 0,
    is_org_admin: team.is_admin,
    working_group_count: Number(wg.wg_count),
    council_count: Number(wg.council_count),
    events_registered: Number(events.registered),
    events_attended: Number(events.attended),
    community_profile_public: community.is_public,
    community_profile_completeness: Math.round((Number(community.completeness_fields) / 10) * 100),
    last_active_days_ago: activity.last_active_days != null ? Number(activity.last_active_days) : null,
    slack_message_count_30d: Number(activity.slack_messages_30d),
    is_committee_leader: leader.is_leader,
  };
}

/**
 * Check if there are any upcoming events relevant to this user.
 *
 * Relevant events include:
 * - Events the user is already registered for
 * - Events in regional chapters the user is a member of
 * - Industry gatherings the user has indicated interest in (attending/interested)
 * - Major global events (summits) that are open to all
 *
 * This is used by the planner to skip the "Discover Events" goal when
 * there are no relevant events to suggest.
 */
export async function hasRelevantUpcomingEvents(
  workosUserId?: string,
  slackUserId?: string
): Promise<{
  hasRelevantEvents: boolean;
  userLocation: { city: string | null; country: string | null };
  details: {
    registered: number;
    industryGatherings: number;
    chapterEvents: number;
    globalSummits: number;
  };
}> {
  // If no user identifier, no relevant events
  if (!workosUserId && !slackUserId) {
    return {
      hasRelevantEvents: false,
      userLocation: { city: null, country: null },
      details: { registered: 0, industryGatherings: 0, chapterEvents: 0, globalSummits: 0 },
    };
  }

  // Query all relevant event counts in parallel
  const [
    registeredResult,
    industryGatheringsResult,
    chapterEventsResult,
    globalSummitsResult,
    locationResult,
  ] = await Promise.all([
    // Events user is registered for (excluding virtual events)
    workosUserId ? query<{ count: number }>(
      `SELECT COUNT(*) as count
       FROM event_registrations er
       JOIN events e ON e.id = er.event_id
       WHERE er.workos_user_id = $1
         AND e.status = 'published'
         AND e.start_time > NOW()
         AND e.event_format != 'virtual'`,
      [workosUserId]
    ) : Promise.resolve({ rows: [{ count: 0 }] }),

    // Industry gatherings user is interested in or attending
    workosUserId ? query<{ count: number }>(
      `SELECT COUNT(*) as count
       FROM working_group_memberships wgm
       JOIN working_groups wg ON wg.id = wgm.working_group_id
       WHERE wgm.workos_user_id = $1
         AND wg.committee_type = 'industry_gathering'
         AND wg.status = 'active'
         AND wgm.status = 'active'
         AND wgm.interest_level IN ('attending', 'interested')
         AND (wg.event_end_date IS NULL OR wg.event_end_date >= CURRENT_DATE)`,
      [workosUserId]
    ) : Promise.resolve({ rows: [{ count: 0 }] }),

    // Events in chapters user is a member of
    workosUserId ? query<{ count: number }>(
      `SELECT COUNT(DISTINCT e.id) as count
       FROM events e
       JOIN working_groups wg ON wg.committee_type = 'chapter' AND wg.status = 'active'
       JOIN working_group_memberships wgm ON wgm.working_group_id = wg.id
       WHERE wgm.workos_user_id = $1
         AND wgm.status = 'active'
         AND e.status = 'published'
         AND e.start_time > NOW()
         AND e.event_format != 'virtual'
         AND (
           -- Match chapter region to event city (case-insensitive)
           LOWER(e.venue_city) LIKE '%' || LOWER(COALESCE(wg.region, '')) || '%'
           OR LOWER(COALESCE(wg.region, '')) LIKE '%' || LOWER(COALESCE(e.venue_city, '')) || '%'
         )`,
      [workosUserId]
    ) : Promise.resolve({ rows: [{ count: 0 }] }),

    // Global summits (open to all members)
    query<{ count: number }>(
      `SELECT COUNT(*) as count
       FROM events
       WHERE status = 'published'
         AND start_time > NOW()
         AND event_type = 'summit'
         AND event_format != 'virtual'`
    ),

    // User's location from users table
    slackUserId ? query<{ city: string | null; country: string | null }>(
      `SELECT u.city, u.country
       FROM slack_user_mappings sm
       JOIN users u ON u.workos_user_id = sm.workos_user_id
       WHERE sm.slack_user_id = $1
       LIMIT 1`,
      [slackUserId]
    ) : Promise.resolve({ rows: [{ city: null, country: null }] }),
  ]);

  const registered = Number(registeredResult.rows[0]?.count ?? 0);
  const industryGatherings = Number(industryGatheringsResult.rows[0]?.count ?? 0);
  const chapterEvents = Number(chapterEventsResult.rows[0]?.count ?? 0);
  const globalSummits = Number(globalSummitsResult.rows[0]?.count ?? 0);
  const location = locationResult.rows[0] ?? { city: null, country: null };

  const hasRelevantEvents = registered > 0 || industryGatherings > 0 || chapterEvents > 0 || globalSummits > 0;

  return {
    hasRelevantEvents,
    userLocation: location,
    details: { registered, industryGatherings, chapterEvents, globalSummits },
  };
}
