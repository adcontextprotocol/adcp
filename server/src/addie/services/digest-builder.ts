import { createLogger } from '../../logger.js';
import { complete, isLLMConfigured } from '../../utils/llm.js';
import {
  getRecentArticlesForDigest,
  getNewOrganizations,
  type DigestContent,
  type DigestNewsItem,
  type DigestNewMember,
  type DigestConversation,
  type DigestWorkingGroup,
} from '../../db/digest-db.js';
import { WorkingGroupDatabase } from '../../db/working-group-db.js';
import { MeetingsDatabase } from '../../db/meetings-db.js';

const workingGroupDb = new WorkingGroupDatabase();
const meetingsDb = new MeetingsDatabase();
import { getChannelHistory, resolveSlackUserDisplayName } from '../../slack/client.js';
import { query } from '../../db/client.js';

const logger = createLogger('digest-builder');

const SLACK_WORKSPACE_URL = process.env.SLACK_WORKSPACE_URL || 'https://agenticadvertising.slack.com';

/**
 * Build all content sections for the weekly digest.
 * Assembles news, new members, conversations, and working group updates.
 */
export async function buildDigestContent(): Promise<DigestContent> {
  logger.info('Building weekly digest content');

  const [news, newMembers, conversations, workingGroups] = await Promise.all([
    buildNewsSection(),
    buildNewMembersSection(),
    buildConversationsSection(),
    buildWorkingGroupsSection(),
  ]);

  const intro = await generateIntro(news, newMembers, conversations, workingGroups);

  const content: DigestContent = {
    intro,
    news,
    newMembers,
    conversations,
    workingGroups,
    generatedAt: new Date().toISOString(),
  };

  logger.info(
    {
      newsCount: news.length,
      newMemberCount: newMembers.length,
      conversationCount: conversations.length,
      workingGroupCount: workingGroups.length,
    },
    'Digest content built',
  );

  return content;
}

/**
 * Check if there's enough content to justify sending a digest this week.
 */
export function hasMinimumContent(content: DigestContent): boolean {
  const totalItems = content.news.length + content.conversations.length + content.workingGroups.length;
  return totalItems >= 2;
}

// --- News Section ---

async function buildNewsSection(): Promise<DigestNewsItem[]> {
  const articles = await getRecentArticlesForDigest(7, 10);

  if (articles.length === 0) {
    logger.info('No recent articles for digest');
    return [];
  }

  if (!isLLMConfigured()) {
    // Return raw articles without AI curation
    return articles.slice(0, 3).map((a) => ({
      title: a.title,
      url: a.source_url,
      summary: a.summary || '',
      whyItMatters: a.addie_notes || '',
      tags: a.relevance_tags || [],
      knowledgeId: a.id,
    }));
  }

  // Use Claude to select top 3 and generate "why it matters"
  const articleList = articles
    .map((a, i) => `${i + 1}. "${a.title}" (score: ${a.quality_score}) - ${a.summary || 'No summary'}`)
    .join('\n');

  const result = await complete({
    system: `You are Addie, the AI assistant for AgenticAdvertising.org, a standards organization for AI-powered advertising.
Select the 3 most relevant articles for our weekly digest and write a brief "why it matters" take for each.
Respond in JSON format: [{"index": 1, "whyItMatters": "..."}]
Keep each "whyItMatters" to 1-2 sentences. Be opinionated and specific about relevance to agentic advertising.`,
    prompt: `Select the top 3 articles from this list for our weekly digest:\n\n${articleList}`,
    maxTokens: 500,
    model: 'fast',
    operationName: 'digest-news-selection',
  });

  try {
    const cleaned = result.text.replace(/^```(?:json)?\n?/m, '').replace(/\n?```$/m, '');
    const selections: Array<{ index: number; whyItMatters: string }> = JSON.parse(cleaned);
    return selections.slice(0, 3).map((sel) => {
      const article = articles[sel.index - 1];
      if (!article) return null;
      return {
        title: article.title,
        url: article.source_url,
        summary: article.summary || '',
        whyItMatters: sel.whyItMatters,
        tags: article.relevance_tags || [],
        knowledgeId: article.id,
      };
    }).filter((item): item is NonNullable<typeof item> => item !== null) as DigestNewsItem[];
  } catch {
    logger.warn('Failed to parse LLM news selection, using top 3 by score');
    return articles.slice(0, 3).map((a) => ({
      title: a.title,
      url: a.source_url,
      summary: a.summary || '',
      whyItMatters: a.addie_notes || '',
      tags: a.relevance_tags || [],
      knowledgeId: a.id,
    }));
  }
}

// --- New Members Section ---

async function buildNewMembersSection(): Promise<DigestNewMember[]> {
  const orgs = await getNewOrganizations(7);
  return orgs.map((org) => ({
    name: org.name,
  }));
}

// --- Notable Conversations Section ---

async function buildConversationsSection(): Promise<DigestConversation[]> {
  // Get public working group channels to scan for notable threads
  const groups = await query<{
    id: string;
    name: string;
    slack_channel_id: string;
  }>(
    `SELECT id, name, slack_channel_id
     FROM working_groups
     WHERE slack_channel_id IS NOT NULL
       AND is_private = FALSE
       AND status = 'active'`,
  );

  if (groups.rows.length === 0) {
    return [];
  }

  const oneWeekAgo = String(Math.floor((Date.now() - 7 * 24 * 60 * 60 * 1000) / 1000));
  const notableThreads: Array<{
    channelName: string;
    channelId: string;
    text: string;
    ts: string;
    replyCount: number;
    user?: string;
  }> = [];

  // Scan each public channel for threads with high reply counts
  for (const group of groups.rows) {
    try {
      const history = await getChannelHistory(group.slack_channel_id, {
        oldest: oneWeekAgo,
        limit: 50,
      });

      for (const msg of history.messages) {
        if (msg.reply_count && msg.reply_count >= 3 && msg.text && !msg.bot_id) {
          notableThreads.push({
            channelName: group.name,
            channelId: group.slack_channel_id,
            text: msg.text.slice(0, 200),
            ts: msg.ts,
            replyCount: msg.reply_count,
            user: msg.user,
          });
        }
      }
    } catch (err) {
      logger.warn({ channelId: group.slack_channel_id, error: err }, 'Failed to fetch channel history');
    }
  }

  if (notableThreads.length === 0) {
    return [];
  }

  // Sort by reply count and take top 2
  notableThreads.sort((a, b) => b.replyCount - a.replyCount);
  const topThreads = notableThreads.slice(0, 2);

  const conversations: DigestConversation[] = [];
  for (const thread of topThreads) {
    let participantName = 'A member';
    if (thread.user) {
      const resolved = await resolveSlackUserDisplayName(thread.user);
      if (resolved?.display_name) {
        participantName = resolved.display_name;
      }
    }

    const threadUrl = `${SLACK_WORKSPACE_URL}/archives/${thread.channelId}/p${thread.ts.replace('.', '')}`;

    conversations.push({
      summary: `${participantName} started a discussion with ${thread.replyCount} replies: "${thread.text.slice(0, 100)}..."`,
      channelName: thread.channelName,
      threadUrl,
      participants: [participantName],
    });
  }

  return conversations;
}

// --- Working Groups Section ---

async function buildWorkingGroupsSection(): Promise<DigestWorkingGroup[]> {
  const groups = await query<{
    id: string;
    name: string;
  }>(
    `SELECT id, name FROM working_groups
     WHERE status = 'active'
       AND committee_type IN ('working_group', 'steering_committee')
     ORDER BY display_order`,
  );

  const results: DigestWorkingGroup[] = [];
  const allUpcomingMeetings = await meetingsDb.getUpcomingMeetings(10);

  for (const group of groups.rows) {
    const summaries = await workingGroupDb.getCurrentSummaries(group.id);
    const groupMeetings = allUpcomingMeetings.filter(
      (m: { working_group_id?: string }) => m.working_group_id === group.id,
    );

    // Only include groups with recent activity
    if (summaries.length === 0 && groupMeetings.length === 0) {
      continue;
    }

    const latestSummary = summaries[0];
    const nextMeeting = groupMeetings[0];

    results.push({
      name: group.name,
      summary: latestSummary?.summary_text?.slice(0, 200) || 'Active this week',
      nextMeeting: nextMeeting
        ? `${nextMeeting.title} - ${new Date(nextMeeting.start_time).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`
        : undefined,
    });
  }

  return results;
}

// --- Intro Generation ---

async function generateIntro(
  news: DigestNewsItem[],
  newMembers: DigestNewMember[],
  conversations: DigestConversation[],
  workingGroups: DigestWorkingGroup[],
): Promise<string> {
  if (!isLLMConfigured()) {
    return `This week at AgenticAdvertising.org: ${news.length} industry stories, ${newMembers.length} new members, and ${conversations.length} notable conversations.`;
  }

  const context = [];
  if (news.length > 0) context.push(`${news.length} industry stories (top: "${news[0].title}")`);
  if (newMembers.length > 0) context.push(`${newMembers.length} new member${newMembers.length > 1 ? 's' : ''}`);
  if (conversations.length > 0) context.push(`${conversations.length} notable conversation${conversations.length > 1 ? 's' : ''}`);
  if (workingGroups.length > 0) context.push(`${workingGroups.length} working group update${workingGroups.length > 1 ? 's' : ''}`);

  const result = await complete({
    system: `You are Addie, the friendly AI assistant for AgenticAdvertising.org. Write a 1-2 sentence intro for the weekly digest. Be warm, concise, and specific. No emojis.`,
    prompt: `Write an intro for this week's digest. Content: ${context.join(', ')}.`,
    maxTokens: 150,
    model: 'fast',
    operationName: 'digest-intro',
  });

  return result.text;
}
