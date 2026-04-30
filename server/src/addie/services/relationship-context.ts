import { query } from '../../db/client.js';
import { isPayingMembership } from '../../db/org-filters.js';
import * as relationshipDb from '../../db/relationship-db.js';
import { getMemberCapabilities, hasRelevantUpcomingEvents } from '../../db/outbound-db.js';
import * as certDb from '../../db/certification-db.js';
import { computeUserTier, type TierName } from '../../services/user-journey.js';
import { createLogger } from '../../logger.js';

const logger = createLogger('relationship-context');
import type { PersonRelationship } from '../../db/relationship-db.js';
import type { MemberCapabilities } from '../types.js';
import type { CertificationSummary } from './engagement-planner.js';

// Cache aggregate cert stats for 5 minutes (changes slowly)
let _certStatsCache: { value: { totalCertified: number; totalOrgs: number }; expiry: number } | null = null;
async function getCachedCertAggregateStats() {
  if (_certStatsCache && Date.now() < _certStatsCache.expiry) return _certStatsCache.value;
  const stats = await certDb.getCertAggregateStats();
  _certStatsCache = { value: stats, expiry: Date.now() + 5 * 60 * 1000 };
  return stats;
}

// =====================================================
// TYPES
// =====================================================

export interface JourneyContext {
  tier: TierName;
  points: number;
  working_groups: string[];
  credentials: string[];
  contribution_count: number;
  notable_colleagues: Array<{ name: string; highlights: string[] }>;
}

export interface RelationshipContext {
  relationship: PersonRelationship;
  recentMessages: CrossSurfaceMessage[];
  profile: {
    capabilities: MemberCapabilities | null;
    company: CompanyInfo | null;
  };
  certification: CertificationSummary | null;
  community?: CommunityContext;
  journey?: JourneyContext;
  /** Identity / account state — derived flags so callers don't re-check. */
  identity: IdentityFlags;
  /** Communication preferences gathered from the relationship row + email prefs. */
  preferences: PreferencesContext;
  /** Pending or recently-expired membership invites for this person's email. */
  invites: InviteSummary[];
  /** Last few threads with this person across surfaces (titled when known). */
  recentThreads: ThreadSummary[];
  /**
   * Every WorkOS org this person belongs to (versus `profile.company` which
   * is one). Empty when the person isn't WorkOS-linked. Use this to answer
   * "is this person in org X?" — the live-thread sample showed Addie
   * conflating "in Slack" with "in WorkOS org Y" because she only had
   * `profile.company` to work with.
   */
  orgMemberships: OrgMembership[];
}

export interface IdentityFlags {
  account_linked: boolean;
  has_slack: boolean;
  has_email: boolean;
}

export interface PreferencesContext {
  contact_preference: 'slack' | 'email' | null;
  opted_out: boolean;
  marketing_opt_in: boolean | null;
}

export interface InviteSummary {
  org_id: string;
  org_name: string | null;
  lookup_key: string;
  status: 'pending' | 'expired';
  created_at: Date;
  expires_at: Date;
  invited_by_user_id: string;
}

export interface ThreadSummary {
  thread_id: string;
  channel: string;
  title: string | null;
  message_count: number;
  last_message_at: Date;
  created_at: Date;
}

/**
 * Per-org membership for a person. The existing `profile.company` field is
 * the LIMIT 1 join — sufficient for most queries but loses information for
 * people who belong to multiple orgs, and conflates "the org we picked" with
 * "the org being asked about." This surface is the explicit answer to "what
 * orgs does this person belong to, and in what capacity."
 */
export interface OrgMembership {
  workos_organization_id: string;
  org_name: string;
  role: 'admin' | 'member' | null;
  seat_type: 'contributor' | 'community_only' | null;
  provisioning_source: string | null;
  is_paying_member: boolean;
  joined_at: Date;
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

  const { slack_user_id, workos_user_id, prospect_org_id, email } = relationship;

  // Fan out all independent queries in parallel
  const [
    messages,
    capabilities,
    company,
    certification,
    community,
    journey,
    invites,
    marketingOptIn,
    recentThreads,
    orgMemberships,
  ] = await Promise.all([
      // Recent messages across all surfaces
      loadRecentMessages(personId),

      // Member capabilities
      slack_user_id
        ? getMemberCapabilities(slack_user_id, workos_user_id ?? undefined)
        : Promise.resolve(null),

      // Company info
      loadCompanyInfo(workos_user_id, prospect_org_id),

      // Certification progress
      workos_user_id ? loadCertificationSummary(workos_user_id) : Promise.resolve(null),

      // Community context (only when requested)
      options?.includeCommunity
        ? loadCommunityContext(workos_user_id, slack_user_id)
        : Promise.resolve(undefined),

      // Journey context (tier, groups, credentials, notable colleagues)
      workos_user_id ? loadJourneyContext(workos_user_id) : Promise.resolve(undefined),

      // Pending + expired membership invites for this person's email
      email ? loadInviteSummaries(email) : Promise.resolve([]),

      // Marketing opt-in (lives on user_email_preferences keyed by workos user)
      workos_user_id ? loadMarketingOptIn(workos_user_id) : Promise.resolve(null),

      // Recent thread index (titles where set + channel + last_message_at)
      loadRecentThreads(personId),

      // All WorkOS orgs this person belongs to (multi-org / role / seat_type)
      workos_user_id ? loadOrgMemberships(workos_user_id) : Promise.resolve([]),
    ]);

  return {
    relationship,
    recentMessages: messages,
    profile: {
      capabilities,
      company,
    },
    certification,
    community,
    journey,
    identity: {
      account_linked: workos_user_id !== null,
      has_slack: slack_user_id !== null,
      has_email: email !== null,
    },
    preferences: {
      contact_preference: relationship.contact_preference,
      opted_out: relationship.opted_out,
      marketing_opt_in: marketingOptIn,
    },
    invites,
    recentThreads,
    orgMemberships,
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
      subscription_canceled_at: Date | null;
      prospect_owner: string | null;
    }>(
      `SELECT o.name, o.company_types, o.persona, o.subscription_status,
              o.subscription_canceled_at, o.prospect_owner
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
      is_member: isPayingMembership(row),
      is_addie_prospect: row.prospect_owner !== null,
    };
  }

  if (prospectOrgId) {
    const result = await query<{
      name: string;
      company_types: string[];
      persona: string | null;
      subscription_status: string | null;
      subscription_canceled_at: Date | null;
      prospect_owner: string | null;
    }>(
      `SELECT name, company_types, persona, subscription_status,
              subscription_canceled_at, prospect_owner
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
      is_member: isPayingMembership(row),
      is_addie_prospect: row.prospect_owner !== null,
    };
  }

  return null;
}

async function loadCertificationSummary(workosUserId: string): Promise<CertificationSummary | null> {
  try {
    const [progress, credentials, modules, abandoned] = await Promise.all([
      certDb.getProgress(workosUserId),
      certDb.getUserCredentials(workosUserId),
      certDb.getModules(),
      certDb.getAbandonedModule(workosUserId),
    ]);

    const summary: CertificationSummary = {
      modulesCompleted: progress.filter(p => p.status === 'completed' || p.status === 'tested_out').length,
      totalModules: modules.length,
      credentialsEarned: credentials.map(c => c.credential_id),
      hasInProgressTrack: progress.some(p => p.status === 'in_progress'),
      abandonedModuleTitle: abandoned?.title ?? null,
    };

    // Load expectation and team progress if user belongs to an org
    try {
      const orgResult = await query<{ workos_organization_id: string }>(
        `SELECT workos_organization_id FROM organization_memberships
         WHERE workos_user_id = $1 LIMIT 1`,
        [workosUserId]
      );
      const orgId = orgResult.rows[0]?.workos_organization_id;
      if (orgId) {
        const [expectation, teamProgress, globalStats] = await Promise.all([
          certDb.getCertExpectationForUser(orgId, workosUserId),
          certDb.getOrgCertProgress(orgId),
          getCachedCertAggregateStats(),
        ]);
        if (expectation) {
          summary.expectationStatus = expectation.status;
          summary.snoozedUntil = expectation.snooze_until;
        }
        if (teamProgress.total > 1) {
          summary.teamCertProgress = teamProgress;
        }
        if (globalStats.totalCertified >= 10) {
          summary.globalCertifiedCount = globalStats.totalCertified;
        }

        // Check if completion was already celebrated
        if (expectation?.status === 'completed') {
          const celebratedResult = await query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM person_events
             WHERE person_id = (SELECT id FROM person_relationships WHERE workos_user_id = $1 LIMIT 1)
               AND event_type = 'message_sent'
               AND data->>'goal_hint' = 'cert_completion_congrats'`,
            [workosUserId]
          );
          summary.completionCelebrated = parseInt(celebratedResult.rows[0]?.count || '0') > 0;
        }
      }
    } catch {
      // Non-critical — expectation/team data is optional
    }

    return summary;
  } catch {
    return null;
  }
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

async function loadInviteSummaries(email: string): Promise<InviteSummary[]> {
  // Pending or just-expired invites for this email across any org. Useful
  // signal for "they have an invite waiting" / "their invite expired."
  // Accepted/revoked are excluded — they're history, not actionable state.
  try {
    const result = await query<{
      workos_organization_id: string;
      org_name: string | null;
      lookup_key: string;
      created_at: Date;
      expires_at: Date;
      invited_by_user_id: string;
      accepted_at: Date | null;
      revoked_at: Date | null;
    }>(
      `SELECT mi.workos_organization_id, o.name AS org_name, mi.lookup_key,
              mi.created_at, mi.expires_at, mi.invited_by_user_id,
              mi.accepted_at, mi.revoked_at
       FROM membership_invites mi
       LEFT JOIN organizations o ON o.workos_organization_id = mi.workos_organization_id
       WHERE mi.contact_email = $1
         AND mi.accepted_at IS NULL
         AND mi.revoked_at IS NULL
       ORDER BY mi.created_at DESC
       LIMIT 10`,
      [email]
    );
    const now = Date.now();
    return result.rows.map((r) => ({
      org_id: r.workos_organization_id,
      org_name: r.org_name,
      lookup_key: r.lookup_key,
      status: new Date(r.expires_at).getTime() > now ? 'pending' : 'expired',
      created_at: new Date(r.created_at),
      expires_at: new Date(r.expires_at),
      invited_by_user_id: r.invited_by_user_id,
    }));
  } catch (err) {
    logger.error({ err, email }, 'Failed to load invite summaries');
    return [];
  }
}

async function loadMarketingOptIn(workosUserId: string): Promise<boolean | null> {
  try {
    const result = await query<{ marketing_opt_in: boolean | null }>(
      `SELECT marketing_opt_in FROM user_email_preferences WHERE workos_user_id = $1 LIMIT 1`,
      [workosUserId]
    );
    return result.rows[0]?.marketing_opt_in ?? null;
  } catch (err) {
    logger.error({ err, workosUserId }, 'Failed to load marketing opt-in');
    return null;
  }
}

async function loadOrgMemberships(workosUserId: string): Promise<OrgMembership[]> {
  try {
    const result = await query<{
      workos_organization_id: string;
      org_name: string;
      role: string | null;
      seat_type: string | null;
      provisioning_source: string | null;
      subscription_status: string | null;
      subscription_canceled_at: Date | null;
      created_at: Date;
    }>(
      `SELECT om.workos_organization_id,
              o.name AS org_name,
              om.role,
              om.seat_type,
              om.provisioning_source,
              o.subscription_status,
              o.subscription_canceled_at,
              om.created_at
       FROM organization_memberships om
       JOIN organizations o ON o.workos_organization_id = om.workos_organization_id
       WHERE om.workos_user_id = $1
       ORDER BY om.created_at DESC`,
      [workosUserId]
    );
    return result.rows.map((r) => ({
      workos_organization_id: r.workos_organization_id,
      org_name: r.org_name,
      role: r.role === 'admin' || r.role === 'member' ? r.role : null,
      seat_type:
        r.seat_type === 'contributor' || r.seat_type === 'community_only'
          ? r.seat_type
          : null,
      provisioning_source: r.provisioning_source,
      is_paying_member: isPayingMembership(r),
      joined_at: new Date(r.created_at),
    }));
  } catch (err) {
    logger.error({ err, workosUserId }, 'Failed to load org memberships');
    return [];
  }
}

async function loadRecentThreads(personId: string): Promise<ThreadSummary[]> {
  try {
    const result = await query<{
      thread_id: string;
      channel: string;
      title: string | null;
      message_count: number;
      last_message_at: Date;
      created_at: Date;
    }>(
      `SELECT thread_id, channel, title, message_count, last_message_at, created_at
       FROM addie_threads
       WHERE person_id = $1
       ORDER BY last_message_at DESC NULLS LAST
       LIMIT 5`,
      [personId]
    );
    return result.rows.map((r) => ({
      thread_id: r.thread_id,
      channel: r.channel,
      title: r.title,
      message_count: r.message_count,
      last_message_at: new Date(r.last_message_at),
      created_at: new Date(r.created_at),
    }));
  } catch (err) {
    logger.error({ err, personId }, 'Failed to load recent threads');
    return [];
  }
}

async function loadJourneyContext(workosUserId: string): Promise<JourneyContext | undefined> {
  try {
    const [pointsResult, groupsResult, credsResult, contribResult, colleaguesResult] = await Promise.all([
      query<{ total: string }>(
        `SELECT COALESCE(SUM(points), 0) as total FROM community_points WHERE workos_user_id = $1`,
        [workosUserId]
      ),
      query<{ name: string }>(
        `SELECT wg.name FROM working_groups wg
         JOIN working_group_memberships wgm ON wgm.working_group_id = wg.id
         WHERE wgm.workos_user_id = $1 AND wgm.status = 'active'`,
        [workosUserId]
      ),
      query<{ name: string }>(
        `SELECT cc.name FROM user_credentials uc
         JOIN certification_credentials cc ON cc.id = uc.credential_id
         WHERE uc.workos_user_id = $1`,
        [workosUserId]
      ),
      query<{ count: string }>(
        `SELECT COUNT(*) as count FROM perspectives
         WHERE (author_user_id = $1 OR proposer_user_id = $1) AND status = 'published'`,
        [workosUserId]
      ),
      // Notable colleagues at same org (top 3 most engaged, excluding self)
      query<{ name: string; credentials: string | null; groups: string | null; contribution_count: string }>(
        `SELECT
           COALESCE(u.first_name || ' ' || u.last_name, u.email) as name,
           (SELECT string_agg(DISTINCT cc.name, ', ')
            FROM user_credentials uc
            JOIN certification_credentials cc ON cc.id = uc.credential_id
            WHERE uc.workos_user_id = om2.workos_user_id) as credentials,
           (SELECT string_agg(DISTINCT wg.name, ', ')
            FROM working_group_memberships wgm
            JOIN working_groups wg ON wg.id = wgm.working_group_id
            WHERE wgm.workos_user_id = om2.workos_user_id AND wgm.status = 'active') as groups,
           (SELECT COUNT(*) FROM perspectives p
            WHERE (p.author_user_id = om2.workos_user_id OR p.proposer_user_id = om2.workos_user_id)
              AND p.status = 'published') as contribution_count
         FROM organization_memberships om1
         JOIN organization_memberships om2 ON om2.workos_organization_id = om1.workos_organization_id
         JOIN organizations o ON o.workos_organization_id = om1.workos_organization_id
         JOIN users u ON u.workos_user_id = om2.workos_user_id
         WHERE om1.workos_user_id = $1
           AND om2.workos_user_id != $1
           AND o.is_personal = false
         ORDER BY (SELECT COALESCE(SUM(cp.points), 0) FROM community_points cp WHERE cp.workos_user_id = om2.workos_user_id) DESC
         LIMIT 3`,
        [workosUserId]
      ),
    ]);

    const points = parseInt(pointsResult.rows[0]?.total || '0', 10);
    const tier = computeUserTier(points);

    const colleagues = colleaguesResult.rows
      .filter(c => c.credentials || c.groups || parseInt(c.contribution_count) > 0)
      .map(c => {
        const highlights: string[] = [];
        if (c.credentials) highlights.push(`${c.credentials} certified`);
        if (c.groups) highlights.push(`In ${c.groups}`);
        const count = parseInt(c.contribution_count);
        if (count > 0) highlights.push(`${count} contribution${count > 1 ? 's' : ''}`);
        return { name: c.name, highlights };
      });

    return {
      tier: tier.tier,
      points,
      working_groups: groupsResult.rows.map(r => r.name),
      credentials: credsResult.rows.map(r => r.name),
      contribution_count: parseInt(contribResult.rows[0]?.count || '0', 10),
      notable_colleagues: colleagues,
    };
  } catch (err) {
    logger.error({ err, workosUserId }, 'Failed to load journey context');
    return undefined;
  }
}

// =====================================================
// PROMPT FORMATTING
// =====================================================

/**
 * Render a date as a short human-readable relative phrase ("in 5 days",
 * "3 days ago", "today"). Used in prompt sections so Addie reads dates
 * the way a human would, not as ISO timestamps.
 */
function formatRelativeDate(d: Date): string {
  const diffMs = d.getTime() - Date.now();
  const days = Math.round(diffMs / 86400000);
  if (days === 0) return 'today';
  if (days > 0) return `in ${days} day${days === 1 ? '' : 's'}`;
  return `${-days} day${-days === 1 ? '' : 's'} ago`;
}

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

  lines.push(`**Account linked**: ${ctx.identity.account_linked ? 'Yes' : 'No'}`);
  lines.push(`**Interactions**: ${r.interaction_count} messages across ${channelList}`);
  lines.push(`**Sentiment**: ${r.sentiment_trend}`);
  lines.push(`**Last contact**: Addie ${lastAddieContact}, them ${lastPersonContact}`);

  // Preferences — render when any signal is non-default. opted_out is
  // load-bearing (Addie must not message them); contact_preference and
  // marketing_opt_in shape channel/timing decisions.
  const prefs = ctx.preferences;
  const showPrefs =
    prefs.opted_out ||
    prefs.contact_preference !== null ||
    prefs.marketing_opt_in !== null;
  if (showPrefs) {
    lines.push('');
    lines.push('### Preferences');
    if (prefs.opted_out) {
      lines.push('- ⚠️ **Opted out** — do not contact');
    }
    if (prefs.contact_preference) {
      lines.push(`- Preferred channel: ${prefs.contact_preference}`);
    }
    if (prefs.marketing_opt_in === true) {
      lines.push('- Marketing opt-in: yes');
    } else if (prefs.marketing_opt_in === false) {
      lines.push('- Marketing opt-in: no');
    }
  }

  // Org memberships — every WorkOS org this person belongs to. The header
  // line above shows one company; this section answers "is this person in
  // org X" for any org. High-value when an admin asks about a colleague at
  // a specific org and Addie needs to disambiguate Slack-presence from
  // formal WorkOS membership (the Triton / Affinity Answers pattern).
  // Only render when the person belongs to multiple orgs OR has an
  // off-primary signal worth surfacing (admin role, community_only seat,
  // verified-domain provisioning).
  if (ctx.orgMemberships.length > 0) {
    const showAlways =
      ctx.orgMemberships.length > 1 ||
      ctx.orgMemberships.some(
        (m) => m.role === 'admin' || m.seat_type === 'community_only' || m.provisioning_source === 'verified_domain'
      );
    if (showAlways) {
      lines.push('');
      lines.push('### Org memberships');
      for (const m of ctx.orgMemberships) {
        const parts: string[] = [];
        parts.push(m.role ?? 'member');
        if (m.seat_type === 'community_only') parts.push('community-only seat');
        if (m.is_paying_member) parts.push('paying');
        if (m.provisioning_source) parts.push(`via ${m.provisioning_source}`);
        const joined = m.joined_at.toISOString().split('T')[0];
        lines.push(
          `- **${m.org_name}** (${m.workos_organization_id}) — ${parts.join(', ')}, joined ${joined}`
        );
      }
    }
  }

  // Open invites — pending or expired membership invites for this email.
  // High-value signal: Pubx-shaped "they have an invite waiting" cases.
  if (ctx.invites.length > 0) {
    lines.push('');
    lines.push('### Open membership invites');
    for (const inv of ctx.invites) {
      const expRel = formatRelativeDate(inv.expires_at);
      const orgLabel = inv.org_name ?? inv.org_id;
      lines.push(
        `- [${inv.status}] ${inv.lookup_key} at ${orgLabel} — expires ${expRel}`
      );
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

  // Recent threads — index of past threads with this person across surfaces.
  // Different from "Recent conversation" above (which shows raw messages);
  // this surfaces older threads Addie can reference without flooding the
  // prompt. Placed after capabilities + conversation since this is a soft
  // index, not a decision-shaping signal.
  if (ctx.recentThreads.length > 0) {
    lines.push('');
    lines.push('### Recent threads');
    for (const t of ctx.recentThreads) {
      const lastRel = formatRelativeDate(t.last_message_at);
      const msgPlural = t.message_count === 1 ? 'message' : 'messages';
      const titlePart = t.title ? ` "${t.title}"` : '';
      lines.push(
        `- [${t.channel}]${titlePart} — ${t.message_count} ${msgPlural}, last ${lastRel}`
      );
    }
  }

  // Journey context
  if (ctx.journey) {
    lines.push('');
    lines.push('### Journey');
    lines.push(`- **Tier**: ${ctx.journey.tier} (${ctx.journey.points} points)`);
    if (ctx.journey.credentials.length > 0) {
      lines.push(`- **Credentials**: ${ctx.journey.credentials.join(', ')}`);
    }
    if (ctx.journey.working_groups.length > 0) {
      lines.push(`- **Working groups**: ${ctx.journey.working_groups.join(', ')}`);
    }
    if (ctx.journey.contribution_count > 0) {
      lines.push(`- **Published content**: ${ctx.journey.contribution_count}`);
    }
    if (ctx.journey.notable_colleagues.length > 0) {
      lines.push('');
      lines.push('### Notable colleagues');
      for (const c of ctx.journey.notable_colleagues) {
        lines.push(`- ${c.name}: ${c.highlights.join(', ')}`);
      }
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

  // Note: account_linked is rendered inline in the header (formatContextForPrompt),
  // sourced from ctx.identity. Don't duplicate it here.

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
