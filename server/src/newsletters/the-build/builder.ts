/**
 * The Build — Content Builder
 *
 * Assembles biweekly content: WG decisions, releases, help needed,
 * contributor spotlights. Generates Sage's status line last.
 *
 * WG content is fetched once and shared across section builders
 * to avoid redundant DB queries.
 */

import { createLogger } from '../../logger.js';
import { complete, isLLMConfigured } from '../../utils/llm.js';
import { generateDateFlavor } from '../cover.js';
import { query } from '../../db/client.js';
import { buildWgDigestContent, getDigestEligibleGroups } from '../../addie/services/wg-digest-builder.js';
import type { WgDigestContent } from '../../db/wg-digest-db.js';
import type {
  BuildContent,
  BuildDecision,
  BuildRelease,
  BuildHelpItem,
  BuildContributor,
  BuildEvent,
} from '../../db/build-db.js';

const logger = createLogger('build-builder');

interface WgEntry {
  groupId: string;
  groupName: string;
  content: WgDigestContent;
}

/**
 * Build all content sections for The Build.
 * Fetches WG content once and passes it to section builders.
 */
export async function buildBuildContent(): Promise<BuildContent> {
  logger.info('Building The Build content');

  // Fetch all WG content once — shared across decisions and help needed
  const groups = await getDigestEligibleGroups();
  const wgEntries: WgEntry[] = [];
  for (const group of groups) {
    const content = await buildWgDigestContent(group.id);
    if (content) {
      wgEntries.push({ groupId: group.id, groupName: content.groupName, content });
    }
  }

  // Build all candidate pools in parallel
  const [decisions, whatShipped, contributorSpotlight, events] = await Promise.all([
    buildDecisionsSection(wgEntries),
    buildReleasesSection(),
    buildContributorSpotlight(),
    buildEventsSection(),
  ]);

  const decisionUrls = new Set(decisions.map((d) => d.url));
  const helpNeeded = await buildHelpNeededSection(wgEntries, decisionUrls);

  const [statusLine, dateFlavor] = await Promise.all([
    generateStatusLine(decisions, whatShipped, helpNeeded, contributorSpotlight),
    generateDateFlavor(),
  ]);

  // Section arrays start empty — editor cherry-picks from candidatePool
  const content: BuildContent = {
    contentVersion: 1,
    statusLine,
    decisions: [],
    whatShipped: [],
    deepDive: null,
    helpNeeded: [],
    contributorSpotlight: [],
    dateFlavor: dateFlavor || undefined,
    generatedAt: new Date().toISOString(),
    candidatePool: {
      decisions,
      whatShipped,
      helpNeeded,
      contributorSpotlight,
      events,
    },
  };

  logger.info(
    {
      candidateDecisions: decisions.length,
      candidateReleases: whatShipped.length,
      candidateHelp: helpNeeded.length,
      candidateSpotlights: contributorSpotlight.length,
      candidateEvents: events.length,
    },
    'The Build candidate pool built',
  );

  return content;
}

/**
 * Check if there's enough content to justify sending.
 */
export function hasBuildMinimumContent(content: BuildContent): boolean {
  const pool = content.candidatePool;
  if (pool) {
    return (pool.decisions?.length || 0) + (pool.whatShipped?.length || 0) + (pool.helpNeeded?.length || 0) + (pool.events?.length || 0) >= 2;
  }
  return content.decisions.length + content.whatShipped.length + content.helpNeeded.length >= 2;
}

/**
 * Generate subject line.
 */
export function generateBuildSubject(content: BuildContent): string {
  if (content.emailSubject) return content.emailSubject;

  if (content.decisions.length > 0) {
    const top = content.decisions[0];
    const prefix = top.status === 'decided' ? 'Decided' : 'Open for comment';
    return `The Build: ${prefix} — ${top.title.slice(0, 45)}`;
  }

  if (content.whatShipped.length > 0) {
    const top = content.whatShipped[0];
    return `The Build: ${top.repo} ${top.version}${top.breaking ? ' (breaking)' : ''}`;
  }

  return 'The Build — What contributors are working on';
}

// ─── Decisions (LLM-classified) ────────────────────────────────────────

/**
 * Extract decisions and proposals from WG activity using LLM classification.
 * Sends meeting recaps and high-engagement threads through an LLM to identify
 * actual decisions vs noise, avoiding false positives from keyword matching.
 */
async function buildDecisionsSection(wgEntries: WgEntry[]): Promise<BuildDecision[]> {
  // Gather all candidate items from WG activity
  const candidates: Array<{
    workingGroup: string;
    workingGroupId: string;
    title: string;
    summary: string;
    url: string;
    source: 'meeting' | 'thread';
  }> = [];

  for (const entry of wgEntries) {
    for (const recap of entry.content.meetingRecaps) {
      if (recap.summary) {
        candidates.push({
          workingGroup: entry.groupName,
          workingGroupId: entry.groupId,
          title: recap.title,
          summary: recap.summary,
          url: recap.meetingUrl,
          source: 'meeting',
        });
      }
    }

    for (const thread of entry.content.activeThreads) {
      if (thread.replyCount >= 4) {
        candidates.push({
          workingGroup: entry.groupName,
          workingGroupId: entry.groupId,
          title: thread.summary.slice(0, 150),
          summary: `${thread.replyCount} replies${thread.starter ? ` started by ${thread.starter}` : ''}`,
          url: thread.threadUrl,
          source: 'thread',
        });
      }
    }
  }

  if (candidates.length === 0) return [];

  // Use LLM to classify candidates as decisions, proposals, or noise
  if (!isLLMConfigured()) {
    // Fallback: treat meetings as decided, threads as under review
    return candidates.slice(0, 8).map((c, i) => ({
      id: `decision_${c.workingGroupId}_${i}`,
      workingGroup: c.workingGroup,
      workingGroupId: c.workingGroupId,
      title: c.title,
      status: c.source === 'meeting' ? 'decided' as const : 'under_review' as const,
      summary: c.summary,
      url: c.url,
    }));
  }

  const candidateList = candidates.map((c, i) =>
    `${i + 1}. [${c.source}] ${c.workingGroup}: "${c.title}" — ${c.summary}`
  ).join('\n');

  const result = await complete({
    system: `You are classifying working group activity for a contributor newsletter.

For each item, determine if it is:
- "decided": A substantive decision was made (policy adopted, spec approved, vote concluded). NOT procedural (agenda approved, meeting scheduled).
- "open_for_comment": A proposal or draft is seeking feedback. Someone is asking for input on a specific question.
- "noise": General discussion, status updates, logistics, or items that don't represent a decision or proposal.

Respond in JSON: [{"index": N, "status": "decided"|"open_for_comment"|"noise", "title": "cleaned up title (max 80 chars)"}]
Only include items that are NOT noise. Be conservative — if unclear, classify as noise.`,
    prompt: `Classify these working group items:\n\n${candidateList}`,
    maxTokens: 800,
    model: 'fast',
    operationName: 'build-decision-classification',
  });

  try {
    const cleaned = result.text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '');
    const classifications: Array<{ index: number; status: string; title: string }> = JSON.parse(cleaned);

    return classifications
      .filter((c) => c.status === 'decided' || c.status === 'open_for_comment')
      .slice(0, 8)
      .map((c) => {
        const candidate = candidates[c.index - 1];
        if (!candidate) return null;
        return {
          id: `decision_${candidate.workingGroupId}_${c.index}`,
          workingGroup: candidate.workingGroup,
          workingGroupId: candidate.workingGroupId,
          title: c.title || candidate.title,
          status: c.status as BuildDecision['status'],
          summary: candidate.summary,
          url: candidate.url,
        };
      })
      .filter((d): d is NonNullable<typeof d> => d !== null);
  } catch {
    logger.warn('Failed to parse LLM decision classification, using source-based fallback');
    return candidates.slice(0, 8).map((c, i) => ({
      id: `decision_${c.workingGroupId}_fallback_${i}`,
      workingGroup: c.workingGroup,
      workingGroupId: c.workingGroupId,
      title: c.title,
      status: c.source === 'meeting' ? 'decided' as const : 'under_review' as const,
      summary: c.summary,
      url: c.url,
    }));
  }
}

// ─── Releases ──────────────────────────────────────────────────────────

async function buildReleasesSection(): Promise<BuildRelease[]> {
  try {
    // Query both explicit release entries AND articles about releases/SDKs/versions
    const result = await query<{
      title: string;
      source_url: string;
      summary: string;
      addie_notes: string;
      relevance_tags: string[];
      created_at: Date;
    }>(
      `SELECT title, source_url, summary, addie_notes, relevance_tags, created_at
       FROM addie_knowledge
       WHERE created_at > NOW() - INTERVAL '21 days'
         AND quality_score >= 3
         AND is_active = TRUE
         AND (
           source_type IN ('changelog', 'release')
           OR title ~* '(release|v\\d+\\.\\d+|SDK|client|RC\\d+|shipped)'
           OR EXISTS (SELECT 1 FROM unnest(relevance_tags) t WHERE t IN ('release', 'sdk', 'client', 'changelog'))
         )
       ORDER BY created_at DESC
       LIMIT 12`,
    );

    return result.rows.map((row) => {
      const isBreaking = row.title.toLowerCase().includes('breaking') ||
        (row.addie_notes || '').toLowerCase().includes('breaking');
      const versionMatch = row.title.match(/v?(\d+\.\d+\.\d+)/);
      const repo = row.relevance_tags?.[0] || 'adcontextprotocol';
      const version = versionMatch?.[1] || '';
      return {
        id: `release_${repo}_${version || row.created_at.toISOString().split('T')[0]}`,
        repo,
        version,
        releaseDate: row.created_at.toISOString().split('T')[0],
        summary: row.summary || row.title,
        releaseUrl: row.source_url,
        breaking: isBreaking,
        migrationNote: isBreaking ? (row.addie_notes || null) : null,
      };
    });
  } catch {
    logger.warn('Failed to fetch releases for The Build');
    return [];
  }
}

// ─── Help Needed ───────────────────────────────────────────────────────

async function buildHelpNeededSection(wgEntries: WgEntry[], decisionUrls: Set<string>): Promise<BuildHelpItem[]> {
  const items: BuildHelpItem[] = [];

  for (const entry of wgEntries) {
    for (const thread of entry.content.activeThreads) {
      // Skip threads already surfaced as decisions
      if (decisionUrls.has(thread.threadUrl)) continue;

      const lower = thread.summary.toLowerCase();

      // Look for active asks, not resolved ones
      // Skip if the summary suggests it's already resolved
      if (lower.includes('solved') || lower.includes('resolved') || lower.includes('thanks, that worked') || lower.includes('closed')) continue;

      if (lower.includes('help') || lower.includes('review') || lower.includes('feedback') || lower.includes('volunteer') || lower.includes('input needed') || lower.includes('looking for')) {
        items.push({
          id: `help_${entry.groupId}_${items.length}`,
          title: thread.summary.slice(0, 120),
          url: thread.threadUrl,
          source: entry.groupName,
          type: lower.includes('review') ? 'review' : lower.includes('writing') ? 'writing' : 'expertise',
          context: `${thread.replyCount} replies — ${thread.starter || 'A contributor'} is looking for input`,
        });
      }
    }
  }

  return items.slice(0, 5);
}

// ─── Contributor Spotlight ─────────────────────────────────────────────

async function buildContributorSpotlight(): Promise<BuildContributor[]> {
  try {
    const result = await query<{
      first_name: string;
      last_name: string;
      title: string;
      slug: string;
    }>(
      `SELECT u.first_name, u.last_name, p.title, p.slug
       FROM perspectives p
       JOIN content_authors ca ON ca.perspective_id = p.id
       JOIN users u ON u.workos_user_id = ca.user_id
       WHERE p.status = 'published'
         AND p.published_at > NOW() - INTERVAL '14 days'
         AND p.content_origin = 'member'
       ORDER BY p.published_at DESC
       LIMIT 3`,
    );

    return result.rows.map((row) => ({
      id: `contributor_${row.slug}`,
      name: `${row.first_name || ''} ${row.last_name || ''}`.trim() || 'Community member',
      contribution: `Published "${row.title}"`,
      url: `/perspectives/${row.slug}`,
    }));
  } catch {
    logger.warn('Failed to fetch contributor spotlights');
    return [];
  }
}

// ─── Status Line ───────────────────────────────────────────────────────

async function generateStatusLine(
  decisions: BuildDecision[],
  whatShipped: BuildRelease[],
  helpNeeded: BuildHelpItem[],
  contributors: BuildContributor[],
): Promise<string> {
  if (!isLLMConfigured()) {
    const parts: string[] = [];
    if (decisions.length > 0) parts.push(`${decisions.length} WG decisions`);
    if (whatShipped.length > 0) parts.push(`${whatShipped.length} releases`);
    if (helpNeeded.length > 0) parts.push(`${helpNeeded.length} open asks`);
    if (contributors.length > 0) parts.push(`${contributors.length} contributor spotlights`);
    return parts.join(', ') + ' this cycle.';
  }

  const breakingCount = whatShipped.filter((r) => r.breaking).length;
  const decidedCount = decisions.filter((d) => d.status === 'decided').length;
  const openCount = decisions.filter((d) => d.status !== 'decided').length;

  const result = await complete({
    system: `You are Sage, writing the status line for The Build — your biweekly dispatch to contributors building agentic advertising infrastructure.

State what happened and what needs attention. One sentence, maybe two. Be specific — name working groups, count decisions, reference versions if there are releases.

No editorializing. No "exciting." No "busy cycle." Just the facts and what requires action.

Content this cycle:
- ${decidedCount} decisions finalized, ${openCount} open for comment
- ${whatShipped.length} releases${breakingCount > 0 ? ` (${breakingCount} breaking)` : ''}
- ${helpNeeded.length} open asks for help
- ${contributors.length} contributor spotlights`,
    prompt: 'Write the status line for this edition of The Build.',
    maxTokens: 150,
    operationName: 'build-status-line',
  });

  return result.text;
}

// ─── Events ───────────────────────────────────────────────────────────

async function buildEventsSection(): Promise<BuildEvent[]> {
  try {
    // Recent completed events with recaps + upcoming published events
    const result = await query<{
      id: number;
      title: string;
      slug: string;
      start_time: Date;
      end_time: Date | null;
      status: string;
      recap_html: string | null;
      recap_video_url: string | null;
    }>(
      `SELECT id, title, slug, start_time, end_time, status, recap_html, recap_video_url
       FROM events
       WHERE (
         (status = 'completed' AND end_time >= NOW() - INTERVAL '30 days')
         OR (status = 'published' AND start_time >= NOW() - INTERVAL '1 day')
       )
       ORDER BY start_time DESC
       LIMIT 10`,
    );

    return result.rows.map((row) => {
      const isUpcoming = row.status === 'published';
      const hasRecap = !!row.recap_html;
      let recapExcerpt: string | undefined;
      if (hasRecap && row.recap_html) {
        // Strip HTML tags for a plain text excerpt
        recapExcerpt = row.recap_html.replace(/<[^>]+>/g, '').slice(0, 200).trim();
      }
      return {
        id: `event_${row.id}`,
        title: row.title,
        slug: row.slug,
        startTime: row.start_time.toISOString(),
        endTime: row.end_time?.toISOString(),
        status: isUpcoming ? 'upcoming' as const : 'completed' as const,
        hasRecap,
        recapExcerpt,
        recapVideoUrl: row.recap_video_url || undefined,
      };
    });
  } catch {
    logger.warn('Failed to fetch events for The Build');
    return [];
  }
}
