/**
 * Committee Summary Generator Job
 *
 * Periodically generates AI-powered activity summaries for committees.
 * Combines information from tracked documents, posts, and activity logs.
 *
 * Types of summaries:
 * - 'overview': General description of the committee and its purpose
 * - 'activity': Recent activity including document updates and posts
 * - 'changes': Summary of what changed since last update
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../../logger.js';
import { getPool } from '../../db/client.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import type { CommitteeSummaryType } from '../../types.js';

const workingGroupDb = new WorkingGroupDatabase();

// Use same model as main Addie assistant
const SUMMARIZER_MODEL = process.env.ADDIE_MODEL || 'claude-sonnet-4-20250514';

export interface SummaryGeneratorResult {
  committeesProcessed: number;
  summariesGenerated: number;
  errors: number;
}

interface InputSource {
  type: string;
  id: string;
  title: string;
}

/**
 * Get recent posts for a working group
 */
async function getRecentPosts(workingGroupId: string, limit = 10): Promise<Array<{
  id: string;
  title: string;
  excerpt?: string;
  published_at?: Date;
}>> {
  const pool = getPool();
  const result = await pool.query(
    `SELECT id, title, excerpt, published_at
     FROM perspectives
     WHERE working_group_id = $1 AND status = 'published'
     ORDER BY published_at DESC NULLS LAST
     LIMIT $2`,
    [workingGroupId, limit]
  );
  return result.rows;
}

/**
 * Generate an activity summary for a committee
 */
async function generateActivitySummary(
  committeeName: string,
  committeeDescription: string | undefined,
  documents: Array<{ title: string; summary?: string; last_modified_at?: Date }>,
  posts: Array<{ title: string; excerpt?: string; published_at?: Date }>,
  activity: Array<{ activity_type: string; change_summary?: string; detected_at: Date; document_title?: string }>
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const client = new Anthropic({ apiKey });

  // Build context about the committee
  const documentsSection = documents.length > 0
    ? `\nTracked Documents:\n${documents.map(d =>
        `- "${d.title}"${d.summary ? `: ${d.summary}` : ''}${d.last_modified_at ? ` (updated ${formatRelativeDate(d.last_modified_at)})` : ''}`
      ).join('\n')}`
    : '';

  const postsSection = posts.length > 0
    ? `\nRecent Posts:\n${posts.map(p =>
        `- "${p.title}"${p.excerpt ? `: ${p.excerpt.substring(0, 100)}...` : ''}`
      ).join('\n')}`
    : '';

  const recentChanges = activity
    .filter(a => a.activity_type === 'content_changed' && a.change_summary)
    .slice(0, 5);

  const changesSection = recentChanges.length > 0
    ? `\nRecent Document Updates:\n${recentChanges.map(a =>
        `- ${a.document_title || 'Document'}: ${a.change_summary}`
      ).join('\n')}`
    : '';

  const systemPrompt = `You are generating an activity summary for a working group at AgenticAdvertising.org.
Write a concise summary (3-5 sentences) of what this group is working on and any recent activity.
Be informative but brief. Use a professional, neutral tone.
If there's no recent activity, focus on describing the group's purpose and tracked documents.`;

  const userPrompt = `Committee: ${committeeName}
${committeeDescription ? `Description: ${committeeDescription}\n` : ''}
${documentsSection}${postsSection}${changesSection}

Generate a brief activity summary for this committee.`;

  const response = await client.messages.create({
    model: SUMMARIZER_MODEL,
    max_tokens: 400,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const textContent = response.content.find(block => block.type === 'text');
  return textContent?.text || 'No activity summary available.';
}

/**
 * Format a date as relative time
 */
function formatRelativeDate(date: Date): string {
  const now = new Date();
  const diffMs = now.getTime() - new Date(date).getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return 'today';
  if (diffDays === 1) return 'yesterday';
  if (diffDays < 7) return `${diffDays} days ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)} weeks ago`;
  return `${Math.floor(diffDays / 30)} months ago`;
}

/**
 * Generate summary for a single committee
 */
async function generateCommitteeSummary(
  workingGroupId: string,
  summaryType: CommitteeSummaryType
): Promise<void> {
  // Get committee details
  const group = await workingGroupDb.getWorkingGroupById(workingGroupId);
  if (!group) {
    throw new Error(`Working group not found: ${workingGroupId}`);
  }

  // Gather input sources
  const documents = await workingGroupDb.getDocumentsByWorkingGroup(workingGroupId);
  const posts = await getRecentPosts(workingGroupId);
  const activity = await workingGroupDb.getRecentActivity(workingGroupId);

  // Track what we used as inputs
  const inputSources: InputSource[] = [
    ...documents.map(d => ({ type: 'document', id: d.id, title: d.title })),
    ...posts.map(p => ({ type: 'post', id: p.id, title: p.title })),
  ];

  // Generate the summary based on type
  let summaryText: string;

  switch (summaryType) {
    case 'activity':
      summaryText = await generateActivitySummary(
        group.name,
        group.description,
        documents.map(d => ({
          title: d.title,
          summary: d.document_summary ?? undefined,
          last_modified_at: d.last_modified_at ?? undefined,
        })),
        posts,
        activity as Array<{ activity_type: string; change_summary?: string; detected_at: Date; document_title?: string }>
      );
      break;

    case 'overview':
      // For overview, just use the committee description as-is or generate one
      summaryText = group.description || `${group.name} is a working group at AgenticAdvertising.org.`;
      break;

    case 'changes':
      // For changes, focus on recent activity
      const recentChanges = activity
        .filter(a => a.activity_type === 'content_changed')
        .slice(0, 5);

      if (recentChanges.length === 0) {
        summaryText = 'No recent document changes.';
      } else {
        summaryText = recentChanges.map(a =>
          `${(a as any).document_title || 'Document'}: ${(a as any).change_summary || 'Updated'}`
        ).join('\n');
      }
      break;

    default:
      throw new Error(`Unknown summary type: ${summaryType}`);
  }

  // Save the summary
  await workingGroupDb.createSummary(
    workingGroupId,
    summaryType,
    summaryText,
    inputSources,
    undefined, // time_period_start
    undefined, // time_period_end
    'addie'
  );

  logger.debug({
    workingGroupId,
    groupName: group.name,
    summaryType,
    inputSourceCount: inputSources.length,
  }, 'Generated committee summary');
}

/**
 * Run the summary generator job
 */
export async function runSummaryGeneratorJob(options: {
  batchSize?: number;
  summaryType?: CommitteeSummaryType;
} = {}): Promise<SummaryGeneratorResult> {
  const { batchSize = 10, summaryType = 'activity' } = options;

  logger.debug({ batchSize, summaryType }, 'Running committee summary generator job');

  const result: SummaryGeneratorResult = {
    committeesProcessed: 0,
    summariesGenerated: 0,
    errors: 0,
  };

  try {
    // Get committees that need summary refresh
    const committeeIds = await workingGroupDb.getWorkingGroupsNeedingSummaryRefresh(batchSize);
    result.committeesProcessed = committeeIds.length;

    if (committeeIds.length === 0) {
      logger.debug('No committees need summary refresh');
      return result;
    }

    logger.debug({ count: committeeIds.length }, 'Processing committees for summary generation');

    // Process each committee
    for (const workingGroupId of committeeIds) {
      try {
        await generateCommitteeSummary(workingGroupId, summaryType);
        result.summariesGenerated++;

        // Small delay between committees
        await new Promise(resolve => setTimeout(resolve, 1000));
      } catch (error) {
        logger.error({ err: error, workingGroupId }, 'Failed to generate committee summary');
        result.errors++;
      }
    }

    logger.info(result, 'Committee summary generator job completed');
    return result;
  } catch (error) {
    logger.error({ err: error }, 'Committee summary generator job failed');
    throw error;
  }
}

/**
 * Force regenerate summary for a specific committee
 */
export async function regenerateCommitteeSummary(
  workingGroupId: string,
  summaryType: CommitteeSummaryType = 'activity'
): Promise<{ success: boolean; error?: string }> {
  try {
    await generateCommitteeSummary(workingGroupId, summaryType);
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
