/**
 * The Build — Content Builder
 *
 * Assembles biweekly content: WG decisions, releases, help needed,
 * contributor spotlights. Generates Sage's status line last.
 */

import { createLogger } from '../../logger.js';
import { complete, isLLMConfigured } from '../../utils/llm.js';
import { query } from '../../db/client.js';
import { buildWgDigestContent, getDigestEligibleGroups } from '../../addie/services/wg-digest-builder.js';
import type {
  BuildContent,
  BuildDecision,
  BuildRelease,
  BuildHelpItem,
  BuildContributor,
} from '../../db/build-db.js';

const logger = createLogger('build-builder');

/**
 * Build all content sections for The Build.
 */
export async function buildBuildContent(): Promise<BuildContent> {
  logger.info('Building The Build content');

  const [decisions, whatShipped, helpNeeded, contributorSpotlight] = await Promise.all([
    buildDecisionsSection(),
    buildReleasesSection(),
    buildHelpNeededSection(),
    buildContributorSpotlight(),
  ]);

  const statusLine = await generateStatusLine(decisions, whatShipped, helpNeeded, contributorSpotlight);

  const content: BuildContent = {
    contentVersion: 1,
    statusLine,
    decisions,
    whatShipped,
    deepDive: null, // Curated by admin, not auto-generated
    helpNeeded,
    contributorSpotlight,
    generatedAt: new Date().toISOString(),
  };

  logger.info(
    {
      decisionCount: decisions.length,
      releaseCount: whatShipped.length,
      helpCount: helpNeeded.length,
      spotlightCount: contributorSpotlight.length,
    },
    'The Build content built',
  );

  return content;
}

/**
 * Check if there's enough content to justify sending.
 */
export function hasBuildMinimumContent(content: BuildContent): boolean {
  return content.decisions.length + content.whatShipped.length + content.helpNeeded.length >= 2;
}

/**
 * Generate subject line.
 */
export function generateBuildSubject(content: BuildContent): string {
  if (content.emailSubject) return content.emailSubject;

  // Lead with top decision
  if (content.decisions.length > 0) {
    const top = content.decisions[0];
    const prefix = top.status === 'decided' ? 'Decided' : 'Open for comment';
    return `The Build: ${prefix} — ${top.title.slice(0, 45)}`;
  }

  // Lead with release
  if (content.whatShipped.length > 0) {
    const top = content.whatShipped[0];
    return `The Build: ${top.repo} ${top.version}${top.breaking ? ' (breaking)' : ''}`;
  }

  return 'The Build — What contributors are working on';
}

// ─── Decisions ─────────────────────────────────────────────────────────

async function buildDecisionsSection(): Promise<BuildDecision[]> {
  const groups = await getDigestEligibleGroups();
  const decisions: BuildDecision[] = [];

  for (const group of groups) {
    const wgContent = await buildWgDigestContent(group.id);
    if (!wgContent) continue;

    // Extract decisions from meeting recaps and active threads
    for (const recap of wgContent.meetingRecaps) {
      if (recap.summary && (
        recap.summary.toLowerCase().includes('decided') ||
        recap.summary.toLowerCase().includes('approved') ||
        recap.summary.toLowerCase().includes('voted')
      )) {
        decisions.push({
          workingGroup: wgContent.groupName,
          workingGroupId: group.id,
          title: recap.title,
          status: 'decided',
          summary: recap.summary,
          url: recap.meetingUrl,
        });
      }
    }

    // Active threads with high engagement = open discussions
    for (const thread of wgContent.activeThreads) {
      if (thread.replyCount >= 5) {
        decisions.push({
          workingGroup: wgContent.groupName,
          workingGroupId: group.id,
          title: thread.summary.slice(0, 100),
          status: 'under_review',
          summary: `${thread.replyCount} replies from ${thread.participantCount || 'multiple'} participants`,
          url: thread.threadUrl,
        });
      }
    }
  }

  return decisions.slice(0, 8);
}

// ─── Releases ──────────────────────────────────────────────────────────

async function buildReleasesSection(): Promise<BuildRelease[]> {
  try {
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
       WHERE source_type IN ('changelog', 'release')
         AND created_at > NOW() - INTERVAL '14 days'
         AND quality_score >= 3
       ORDER BY created_at DESC
       LIMIT 8`,
    );

    return result.rows.map((row) => {
      const isBreaking = row.title.toLowerCase().includes('breaking') ||
        (row.addie_notes || '').toLowerCase().includes('breaking');
      // Extract repo and version from title if possible
      const versionMatch = row.title.match(/v?(\d+\.\d+\.\d+)/);
      return {
        repo: row.relevance_tags?.[0] || 'adcontextprotocol',
        version: versionMatch?.[1] || '',
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

async function buildHelpNeededSection(): Promise<BuildHelpItem[]> {
  // Pull from WG activity — threads asking for help or review
  const groups = await getDigestEligibleGroups();
  const items: BuildHelpItem[] = [];

  for (const group of groups) {
    const wgContent = await buildWgDigestContent(group.id);
    if (!wgContent) continue;

    for (const thread of wgContent.activeThreads) {
      const lower = thread.summary.toLowerCase();
      if (lower.includes('help') || lower.includes('review') || lower.includes('feedback') || lower.includes('volunteer')) {
        items.push({
          title: thread.summary.slice(0, 120),
          url: thread.threadUrl,
          source: wgContent.groupName,
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
    // Find recently active contributors from community points or perspective authors
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
