import { query } from '../../db/client.js';
import * as relationshipDb from '../../db/relationship-db.js';
import { getMemberCapabilities, hasRelevantUpcomingEvents } from '../../db/outbound-db.js';
import { InsightsDatabase } from '../../db/insights-db.js';
import type { PersonRelationship } from '../../db/relationship-db.js';
import type { MemberCapabilities } from '../types.js';

// =====================================================
// TYPES
// =====================================================

export interface RelationshipContext {
  relationship: PersonRelationship;
  recentMessages: CrossSurfaceMessage[];
  profile: {
    insights: Array<{ type: string; value: string; confidence: string }>;
    capabilities: MemberCapabilities | null;
    company: CompanyInfo | null;
  };
  community?: CommunityContext;
}

export interface CrossSurfaceMessage {
  role: 'user' | 'assistant';
  content: string;
  channel: string;
  created_at: Date;
}

export interface CompanyInfo {
  name: string;
  type: string;
  persona?: string;
  is_member: boolean;
  is_addie_prospect: boolean;
}

export interface CommunityContext {
  upcomingEvents: number;
  recentGroupActivity: string[];
}

// =====================================================
// MAIN FUNCTION
// =====================================================

/**
 * Load the full relationship context for a person across all surfaces.
 * Used by the engagement planner (proactive outreach) and by the
 * conversation handler (reactive chats).
 */
export async function loadRelationshipContext(
  personId: string,
  options?: { includeCommunity?: boolean }
): Promise<RelationshipContext> {
  // Load relationship first — other queries depend on its identifiers
  const relationship = await relationshipDb.getRelationship(personId);
  if (!relationship) {
    throw new Error(`No relationship found for person ${personId}`);
  }

  const { slack_user_id, workos_user_id, prospect_org_id } = relationship;
  const insightsDb = new InsightsDatabase();

  // Fan out all independent queries in parallel
  const [messages, insights, capabilities, company, community] = await Promise.all([
    // Recent messages across all surfaces
    loadRecentMessages(personId),

    // Insights from conversations
    slack_user_id
      ? insightsDb.getInsightsForUser(slack_user_id).then(rows =>
          rows.map(r => ({
            type: r.insight_type_name ?? String(r.insight_type_id),
            value: r.value,
            confidence: r.confidence,
          }))
        )
      : Promise.resolve([]),

    // Member capabilities
    slack_user_id
      ? getMemberCapabilities(slack_user_id, workos_user_id ?? undefined)
      : Promise.resolve(null),

    // Company info
    loadCompanyInfo(workos_user_id, prospect_org_id),

    // Community context (only when requested)
    options?.includeCommunity
      ? loadCommunityContext(workos_user_id, slack_user_id)
      : Promise.resolve(undefined),
  ]);

  return {
    relationship,
    recentMessages: messages,
    profile: {
      insights,
      capabilities,
      company,
    },
    community,
  };
}

// =====================================================
// DATA LOADERS
// =====================================================

async function loadRecentMessages(personId: string): Promise<CrossSurfaceMessage[]> {
  const result = await query<{
    role: 'user' | 'assistant';
    content: string;
    channel: string;
    created_at: Date;
  }>(
    `SELECT m.role, m.content, t.channel, m.created_at
     FROM addie_thread_messages m
     JOIN addie_threads t ON t.thread_id = m.thread_id
     WHERE t.person_id = $1
       AND m.role IN ('user', 'assistant')
     ORDER BY m.created_at DESC
     LIMIT 30`,
    [personId]
  );

  // Reverse so messages are in chronological order
  return result.rows.reverse();
}

async function loadCompanyInfo(
  workosUserId: string | null,
  prospectOrgId: string | null
): Promise<CompanyInfo | null> {
  if (workosUserId) {
    const result = await query<{
      name: string;
      company_types: string[];
      persona: string | null;
      subscription_status: string | null;
      prospect_owner: string | null;
    }>(
      `SELECT o.name, o.company_types, o.persona, o.subscription_status, o.prospect_owner
       FROM organizations o
       JOIN organization_memberships om ON om.workos_organization_id = o.workos_organization_id
       WHERE om.workos_user_id = $1
       LIMIT 1`,
      [workosUserId]
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      name: row.name,
      type: row.company_types?.[0] ?? 'unknown',
      persona: row.persona ?? undefined,
      is_member: row.subscription_status === 'active',
      is_addie_prospect: row.prospect_owner !== null,
    };
  }

  if (prospectOrgId) {
    const result = await query<{
      name: string;
      company_types: string[];
      persona: string | null;
      subscription_status: string | null;
      prospect_owner: string | null;
    }>(
      `SELECT name, company_types, persona, subscription_status, prospect_owner
       FROM organizations
       WHERE workos_organization_id = $1
       LIMIT 1`,
      [prospectOrgId]
    );

    const row = result.rows[0];
    if (!row) return null;

    return {
      name: row.name,
      type: row.company_types?.[0] ?? 'unknown',
      persona: row.persona ?? undefined,
      is_member: row.subscription_status === 'active',
      is_addie_prospect: row.prospect_owner !== null,
    };
  }

  return null;
}

async function loadCommunityContext(
  workosUserId: string | null,
  slackUserId: string | null
): Promise<CommunityContext> {
  const eventInfo = await hasRelevantUpcomingEvents(
    workosUserId ?? undefined,
    slackUserId ?? undefined
  );

  const totalEvents =
    eventInfo.details.registered +
    eventInfo.details.industryGatherings +
    eventInfo.details.chapterEvents +
    eventInfo.details.globalSummits;

  return {
    upcomingEvents: totalEvents,
    recentGroupActivity: [],
  };
}

// =====================================================
// PROMPT FORMATTING
// =====================================================

/**
 * Format relationship context as markdown for injection into Addie's system prompt.
 * Used by both the engagement planner and the conversation handler.
 */
export function formatContextForPrompt(ctx: RelationshipContext): string {
  const { relationship: r, recentMessages, profile } = ctx;

  const channels = new Set(recentMessages.map(m => m.channel));
  const channelList = channels.size > 0 ? Array.from(channels).join(', ') : 'none';

  const lastAddieContact = r.last_addie_message_at
    ? r.last_addie_message_at.toISOString().split('T')[0]
    : 'never';
  const lastPersonContact = r.last_person_message_at
    ? r.last_person_message_at.toISOString().split('T')[0]
    : 'never';
  const stageDate = r.stage_changed_at.toISOString().split('T')[0];

  const lines: string[] = [
    `## Relationship with ${r.display_name ?? 'Unknown'}`,
    `**Stage**: ${r.stage} (since ${stageDate})`,
  ];

  if (profile.company) {
    lines.push(`**Company**: ${profile.company.name} (${profile.company.type})`);
    lines.push(`**Member**: ${profile.company.is_member ? 'Yes' : 'No'}`);
  }

  lines.push(`**Interactions**: ${r.interaction_count} messages across ${channelList}`);
  lines.push(`**Sentiment**: ${r.sentiment_trend}`);
  lines.push(`**Last contact**: Addie ${lastAddieContact}, them ${lastPersonContact}`);

  // Insights
  if (profile.insights.length > 0) {
    lines.push('');
    lines.push('### What we know');
    for (const insight of profile.insights) {
      lines.push(`- ${insight.type}: ${insight.value}`);
    }
  }

  // Capabilities
  const capLines = formatCapabilitiesForPrompt(profile.capabilities);
  if (capLines.length > 0) {
    lines.push('');
    lines.push('### What they\'ve done');
    for (const line of capLines) {
      lines.push(line);
    }
  }

  // Recent conversation (last 10)
  const recentSlice = recentMessages.slice(-10);
  if (recentSlice.length > 0) {
    lines.push('');
    lines.push('### Recent conversation');
    for (const msg of recentSlice) {
      const date = msg.created_at instanceof Date
        ? msg.created_at.toISOString().split('T')[0]
        : String(msg.created_at).split('T')[0];
      const truncated = msg.content.length > 200
        ? msg.content.slice(0, 200) + '...'
        : msg.content;
      lines.push(`**${msg.channel} ${date}** ${msg.role}: ${truncated}`);
    }
  }

  // Community context
  if (ctx.community) {
    lines.push('');
    lines.push('### Community updates');
    lines.push(`- ${ctx.community.upcomingEvents} upcoming events relevant to them`);
  }

  return lines.join('\n');
}

/**
 * Format member capabilities as check/cross lines.
 * Used by formatContextForPrompt and the engagement planner's available actions.
 */
export function formatCapabilitiesForPrompt(caps: MemberCapabilities | null): string[] {
  if (!caps) return [];

  const lines: string[] = [];

  lines.push(caps.account_linked
    ? '- \u2713 Account linked'
    : '- \u2717 Account not linked');

  lines.push(caps.profile_complete
    ? '- \u2713 Profile complete'
    : '- \u2717 Profile incomplete');

  lines.push(caps.offerings_set
    ? '- \u2713 Offerings configured'
    : '- \u2717 Offerings not configured');

  lines.push(caps.email_prefs_configured
    ? '- \u2713 Email preferences configured'
    : '- \u2717 Email preferences not configured');

  if (caps.working_group_count > 0) {
    lines.push(`- \u2713 In ${caps.working_group_count} working groups`);
  } else {
    lines.push('- \u2717 Not in any working groups');
  }

  if (caps.council_count > 0) {
    lines.push(`- \u2713 In ${caps.council_count} councils`);
  }

  if (caps.events_registered > 0) {
    lines.push(`- \u2713 Registered for ${caps.events_registered} events (${caps.events_attended} attended)`);
  } else {
    lines.push('- \u2717 No event registrations');
  }

  lines.push(caps.community_profile_public
    ? `- \u2713 Community profile public (${caps.community_profile_completeness}% complete)`
    : `- \u2717 Community profile not public (${caps.community_profile_completeness}% complete)`);

  if (caps.has_team_members) {
    lines.push('- \u2713 Has team members');
  }

  if (caps.is_committee_leader) {
    lines.push('- \u2713 Committee leader');
  }

  return lines;
}
