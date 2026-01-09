/**
 * Addie Content Curator Service
 *
 * Fetches external content (articles, blog posts, etc.) and generates
 * summaries with Addie's contextual analysis for the AdCP knowledge base.
 *
 * Flow:
 * 1. Queue URL for indexing (from perspectives, web search, or manual)
 * 2. Background job fetches content and converts to markdown
 * 3. Claude generates summary, key insights, and contextual notes
 * 4. Content is indexed for full-text search
 */

import Anthropic from '@anthropic-ai/sdk';
import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { logger } from '../../logger.js';
import { AddieDatabase, type KeyInsight } from '../../db/addie-db.js';
import { getPendingRssPerspectives, type RssPerspective } from '../../db/industry-feeds-db.js';
import { query } from '../../db/client.js';
import { getActiveChannels, type NotificationChannel } from '../../db/notification-channels-db.js';
import { isGoogleDocsUrl, createGoogleDocsToolHandlers } from '../mcp/google-docs.js';

const addieDb = new AddieDatabase();

// Use same model as main Addie assistant
const CURATOR_MODEL = process.env.ADDIE_MODEL || 'claude-sonnet-4-20250514';

/**
 * Fetch URL content and extract article text using Mozilla Readability
 * This extracts just the main article content, removing navigation, ads, footers, etc.
 * For Google Docs URLs, uses the Google Docs API instead of HTTP fetching.
 */
async function fetchUrlContent(url: string): Promise<string> {
  // Handle Google Docs specially via API
  if (isGoogleDocsUrl(url)) {
    return fetchGoogleDocsContent(url);
  }

  const response = await fetch(url, {
    headers: {
      'User-Agent': 'AddieBot/1.0 (AgenticAdvertising.org knowledge curator)',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    signal: AbortSignal.timeout(30000), // 30 second timeout
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();

  // Use Mozilla Readability to extract article content
  // This removes nav, ads, footers, sidebars, etc. automatically
  const { document } = parseHTML(html);
  const reader = new Readability(document);
  const article = reader.parse();

  if (!article || !article.textContent) {
    // Fallback to basic text extraction if Readability fails
    logger.warn({ url }, 'Readability failed to parse article, using fallback');
    const fallbackText = html
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const maxLength = 50000;
    if (fallbackText.length > maxLength) {
      return fallbackText.substring(0, maxLength) + '\n\n[Content truncated...]';
    }
    return fallbackText;
  }

  // Clean up the extracted text
  const text = article.textContent.replace(/\s+/g, ' ').trim();

  // Limit content length to avoid token limits
  const maxLength = 50000;
  if (text.length > maxLength) {
    return text.substring(0, maxLength) + '\n\n[Content truncated...]';
  }

  return text;
}

/**
 * Fetch content from Google Docs using the Google Docs API
 */
async function fetchGoogleDocsContent(url: string): Promise<string> {
  const handlers = createGoogleDocsToolHandlers();

  if (!handlers) {
    throw new Error('Google Docs API not configured - missing credentials');
  }

  const result = await handlers.read_google_doc({ url });

  // Check for errors in the result
  if (result.startsWith('Error:') || result.startsWith("I don't have access")) {
    throw new Error(result);
  }

  // Strip the title/format header if present (e.g., "**Document Name** (txt)\n\n")
  const contentMatch = result.match(/^\*\*[^*]+\*\*[^\n]*\n\n([\s\S]*)$/);
  const content = contentMatch ? contentMatch[1] : result;

  // Limit content length
  const maxLength = 50000;
  if (content.length > maxLength) {
    return content.substring(0, maxLength) + '\n\n[Content truncated...]';
  }

  return content;
}

/**
 * Channel info for routing decisions
 */
interface ChannelForRouting {
  slack_channel_id: string;
  name: string;
  description: string;
}

/**
 * Generate summary and insights using Claude
 * Optionally includes notification channel routing if channels are provided
 */
async function generateAnalysis(
  title: string,
  content: string,
  url: string,
  channels?: ChannelForRouting[]
): Promise<{
  summary: string;
  key_insights: KeyInsight[];
  addie_notes: string;
  relevance_tags: string[];
  quality_score: number | null;
  notification_channels: string[];
}> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const client = new Anthropic({ apiKey });

  // Build channel routing section if channels are provided
  const channelRoutingSection = channels && channels.length > 0
    ? `

**Notification Channel Routing:**
Based on the article content, decide which Slack channels should receive an alert about this article.
Choose channels where the topic strongly aligns with the channel's purpose. If unsure or the article doesn't strongly match any channel, return an empty array.

Available channels:
${channels.map(ch => `- "${ch.slack_channel_id}": ${ch.name} - ${ch.description}`).join('\n')}

Add "notification_channels": ["channel_id", ...] to your JSON response with the IDs of channels that should receive this article.`
    : '';

  const response = await client.messages.create({
    model: CURATOR_MODEL,
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        content: `You are Addie, the AI assistant for AgenticAdvertising.org. Analyze this article and provide structured insights for our knowledge base.

**Article Title:** ${title}
**URL:** ${url}

**Content:**
${content.substring(0, 30000)}

Provide your analysis as JSON with this structure:
{
  "summary": "2-3 sentence summary of the key points",
  "key_insights": [
    {"insight": "First key takeaway", "importance": "high|medium|low"},
    {"insight": "Second key takeaway", "importance": "high|medium|low"}
  ],
  "addie_take": "Your spicy, engagement-driving take (see instructions below)",
  "relevance_tags": ["tag1", "tag2"],
  "quality_score": 1-5${channels && channels.length > 0 ? ',\n  "notification_channels": []' : ''}
}

**addie_take - This is the most important field. Write a short, opinionated take that:**
- Starts with a relevant emoji that fits the article topic
- Is provocative/edgy - take a stance, be spicy
- Connects to agentic advertising, AdCP, or what our community cares about
- Ends with a question or "What's your take?" to invite discussion
- Is 1-2 sentences max, punchy and clickbaity
- Examples:
  - "🤖 Big Tech is building AI agents that lock you into their walled gardens. Is open-source AdCP the antidote, or already too late? What's your take?"
  - "💰 Another day, another ad tech acquisition. Consolidation keeps winners winning. How do independents compete?"
  - "⚖️ This antitrust ruling could reshape how measurement monopolies operate. Good news for open standards?"

**Relevance tags** (2-5 tags for filtering, won't be shown to users):
- Ad Tech: adcp, mcp, a2a, advertising, programmatic, creative, signals, media-buying
- AI: llms, ai-models, ai-agents, machine-learning, responsible-ai
- Business: industry-news, market-trends, case-study, competitor, startup
- Content: tutorial, documentation, opinion, research, announcement

**Quality score:**
- 5: Directly about AdCP or agentic advertising
- 4: About AI agents or advertising technology
- 3: Useful context for AI or tech landscape
- 2: Limited relevance to our focus
- 1: Not useful for our community
${channelRoutingSection}

Return ONLY the JSON, no markdown formatting.`,
      },
    ],
  });

  // Extract JSON from response
  const responseText =
    response.content[0].type === 'text' ? response.content[0].text : '';

  try {
    // Try to parse as JSON directly
    const parsed = JSON.parse(responseText);
    return {
      summary: parsed.summary || '',
      key_insights: parsed.key_insights || [],
      // addie_take is the new field name in the prompt, maps to addie_notes in DB
      addie_notes: parsed.addie_take || parsed.addie_notes || '',
      relevance_tags: parsed.relevance_tags || [],
      // Only use AI-provided score if valid, otherwise null (indicates needs human review)
      quality_score: parsed.quality_score
        ? Math.min(5, Math.max(1, parsed.quality_score))
        : null,
      notification_channels: Array.isArray(parsed.notification_channels)
        ? parsed.notification_channels
        : [],
    };
  } catch {
    // If JSON parsing fails, extract what we can
    // quality_score is null to indicate it needs human review
    logger.warn({ responseText }, 'Failed to parse curator response as JSON');
    return {
      summary: responseText.substring(0, 500),
      key_insights: [],
      addie_notes: '',
      relevance_tags: [],
      quality_score: null,
      notification_channels: [],
    };
  }
}

/**
 * Process a single resource - fetch content and generate analysis
 */
export async function processResource(resource: {
  id: number;
  fetch_url: string;
  title: string;
}): Promise<boolean> {
  logger.info({ id: resource.id, url: resource.fetch_url }, 'Processing resource');

  try {
    // Fetch content
    const content = await fetchUrlContent(resource.fetch_url);

    if (content.length < 100) {
      logger.warn({ id: resource.id }, 'Content too short, marking as failed');
      await addieDb.updateFetchedResource(resource.id, {
        content: '',
        fetch_status: 'failed',
        error_message: 'Content too short',
      });
      return false;
    }

    // Generate analysis
    const analysis = await generateAnalysis(resource.title, content, resource.fetch_url);

    // Update database
    await addieDb.updateFetchedResource(resource.id, {
      content,
      summary: analysis.summary,
      key_insights: analysis.key_insights,
      addie_notes: analysis.addie_notes,
      relevance_tags: analysis.relevance_tags,
      quality_score: analysis.quality_score,
      fetch_status: 'success',
    });

    logger.info(
      {
        id: resource.id,
        quality: analysis.quality_score,
        tags: analysis.relevance_tags,
      },
      'Successfully processed resource'
    );
    return true;
  } catch (error) {
    logger.error({ error, id: resource.id }, 'Failed to process resource');
    await addieDb.updateFetchedResource(resource.id, {
      content: '',
      fetch_status: 'failed',
      error_message: error instanceof Error ? error.message : 'Unknown error',
    });
    return false;
  }
}

/**
 * Process pending resources in batches
 * Called by background job or manually
 */
export async function processPendingResources(options: {
  limit?: number;
  staleAfterDays?: number;
} = {}): Promise<{ processed: number; succeeded: number; failed: number }> {
  const resources = await addieDb.getResourcesNeedingFetch({
    limit: options.limit ?? 5,
    staleAfterDays: options.staleAfterDays ?? 7,
  });

  if (resources.length === 0) {
    logger.debug('No resources need processing');
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  logger.info({ count: resources.length }, 'Processing pending resources');

  let succeeded = 0;
  let failed = 0;

  for (const resource of resources) {
    const success = await processResource(resource);
    if (success) {
      succeeded++;
    } else {
      failed++;
    }

    // Small delay between requests to be respectful
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return { processed: resources.length, succeeded, failed };
}

/**
 * Queue a URL from a perspective external link
 */
export async function queuePerspectiveLink(perspective: {
  id: string;
  title: string;
  external_url: string;
  category: string;
  tags?: string[];
}): Promise<number> {
  // Check if already indexed
  const isIndexed = await addieDb.isUrlIndexed(perspective.external_url);
  if (isIndexed) {
    logger.debug({ url: perspective.external_url }, 'URL already indexed');
    return 0;
  }

  return addieDb.queueResourceForIndexing({
    url: perspective.external_url,
    title: perspective.title,
    category: perspective.category || 'perspective',
    discovery_source: 'perspective_publish',
    discovery_context: {
      perspective_id: perspective.id,
    },
    relevance_tags: perspective.tags,
  });
}

/**
 * Queue a URL from web search results
 * Called when Addie finds useful content via web search
 */
export async function queueWebSearchResult(result: {
  url: string;
  title: string;
  searchQuery: string;
}): Promise<number> {
  // Check if already indexed
  const isIndexed = await addieDb.isUrlIndexed(result.url);
  if (isIndexed) {
    logger.debug({ url: result.url }, 'URL already indexed');
    return 0;
  }

  return addieDb.queueResourceForIndexing({
    url: result.url,
    title: result.title,
    category: 'web_search',
    discovery_source: 'web_search',
    discovery_context: {
      search_query: result.searchQuery,
    },
  });
}

/**
 * Process a single RSS perspective - fetch content and generate analysis
 * Creates/updates the corresponding addie_knowledge entry
 */
async function processRssPerspective(
  perspective: RssPerspective,
  channels: ChannelForRouting[]
): Promise<boolean> {
  logger.debug({ id: perspective.id, url: perspective.external_url }, 'Processing RSS perspective');

  try {
    // Fetch content
    const content = await fetchUrlContent(perspective.external_url);

    if (content.length < 100) {
      logger.warn({ id: perspective.id }, 'RSS content too short, skipping');
      // Create a failed entry so we don't retry forever
      await createOrUpdateRssKnowledge(perspective, {
        content: '',
        fetch_status: 'failed',
        error_message: 'Content too short',
      });
      return false;
    }

    // Generate analysis with channel routing
    const analysis = await generateAnalysis(perspective.title, content, perspective.external_url, channels);

    // Create/update knowledge entry
    await createOrUpdateRssKnowledge(perspective, {
      content,
      summary: analysis.summary,
      key_insights: analysis.key_insights,
      addie_notes: analysis.addie_notes,
      relevance_tags: analysis.relevance_tags,
      quality_score: analysis.quality_score,
      notification_channel_ids: analysis.notification_channels,
      fetch_status: 'success',
    });

    logger.debug(
      {
        id: perspective.id,
        quality: analysis.quality_score,
        tags: analysis.relevance_tags,
        channels: analysis.notification_channels,
      },
      'Successfully processed RSS perspective'
    );
    return true;
  } catch (error) {
    logger.error({ error, id: perspective.id }, 'Failed to process RSS perspective');
    await createOrUpdateRssKnowledge(perspective, {
      content: '',
      fetch_status: 'failed',
      error_message: error instanceof Error ? error.message : 'Unknown error',
    });
    return false;
  }
}

/**
 * Create or update addie_knowledge entry for an RSS perspective
 */
async function createOrUpdateRssKnowledge(
  perspective: RssPerspective,
  data: {
    content: string;
    summary?: string;
    key_insights?: KeyInsight[];
    addie_notes?: string;
    relevance_tags?: string[];
    quality_score?: number | null;
    notification_channel_ids?: string[];
    fetch_status: 'success' | 'failed';
    error_message?: string;
  }
): Promise<void> {
  if (data.fetch_status === 'failed') {
    // Upsert a failed entry
    await query(
      `INSERT INTO addie_knowledge (
        title, category, content, source_url, fetch_url, source_type,
        fetch_status, last_fetched_at, discovery_source, discovery_context, created_by
      ) VALUES ($1, $2, '', $3, $3, 'rss', 'failed', NOW(), 'rss_feed', $4, 'system')
      ON CONFLICT (source_url) DO UPDATE SET
        fetch_status = 'failed',
        last_fetched_at = NOW(),
        updated_at = NOW()`,
      [
        perspective.title,
        perspective.category || 'Industry News',
        perspective.external_url,
        JSON.stringify({ perspective_id: perspective.id, feed_id: perspective.feed_id }),
      ]
    );
    return;
  }

  // Upsert a successful entry with all the analysis data
  await query(
    `INSERT INTO addie_knowledge (
      title, category, content, source_url, fetch_url, source_type,
      fetch_status, last_fetched_at, summary, key_insights, addie_notes,
      relevance_tags, quality_score, mentions_agentic, mentions_adcp,
      notification_channel_ids, discovery_source, discovery_context, created_by,
      published_at
    ) VALUES (
      $1, $2, $3, $4, $4, 'rss', 'success', NOW(), $5, $6, $7,
      $8, $9, $10, $11, $12, 'rss_feed', $13, 'system',
      $14
    )
    ON CONFLICT (source_url) DO UPDATE SET
      content = EXCLUDED.content,
      summary = EXCLUDED.summary,
      key_insights = EXCLUDED.key_insights,
      addie_notes = EXCLUDED.addie_notes,
      relevance_tags = EXCLUDED.relevance_tags,
      quality_score = EXCLUDED.quality_score,
      mentions_agentic = EXCLUDED.mentions_agentic,
      mentions_adcp = EXCLUDED.mentions_adcp,
      notification_channel_ids = EXCLUDED.notification_channel_ids,
      fetch_status = 'success',
      last_fetched_at = NOW(),
      updated_at = NOW(),
      published_at = COALESCE(EXCLUDED.published_at, addie_knowledge.published_at)`,
    [
      perspective.title,
      perspective.category || 'Industry News',
      data.content,
      perspective.external_url,
      data.summary || '',
      data.key_insights ? JSON.stringify(data.key_insights) : null,
      data.addie_notes || '',
      data.relevance_tags || [],
      data.quality_score,
      checkMentionsAgentic(data.content, data.summary || '', data.relevance_tags || []),
      checkMentionsAdcp(data.content, data.summary || ''),
      data.notification_channel_ids || [],
      JSON.stringify({ perspective_id: perspective.id, feed_id: perspective.feed_id }),
      perspective.published_at || null,
    ]
  );
}

/**
 * Check if content mentions agentic AI concepts
 * Only checks the original article content (not AI-generated summary) to avoid false positives
 */
function checkMentionsAgentic(content: string, _summary: string, tags: string[]): boolean {
  const text = content.toLowerCase();
  const agenticTerms = ['agentic', 'ai agent', 'ai-agent', 'autonomous agent', 'llm agent'];
  if (agenticTerms.some(term => text.includes(term))) {
    return true;
  }
  if (tags.some(tag => tag.includes('agent') || tag === 'a2a' || tag === 'mcp')) {
    return true;
  }
  return false;
}

/**
 * Check if content mentions AdCP or AgenticAdvertising
 * Only checks the original article content (not AI-generated summary) to avoid false positives
 */
function checkMentionsAdcp(content: string, _summary: string): boolean {
  const text = content.toLowerCase();
  const adcpTerms = ['adcp', 'adcontextprotocol', 'agenticadvertising', 'agentic advertising'];
  return adcpTerms.some(term => text.includes(term));
}

/**
 * Process pending community articles in batches
 * These are articles shared by members in managed channels
 */
export async function processCommunityArticles(options: {
  limit?: number;
} = {}): Promise<{ processed: number; succeeded: number; failed: number }> {
  const limit = options.limit ?? 5;

  // Get pending community articles
  const result = await query<{
    id: number;
    source_url: string;
    title: string;
    discovery_context: {
      shared_by_user_id: string;
      shared_by_display_name?: string;
      channel_id: string;
      message_ts: string;
    };
  }>(
    `SELECT id, source_url, title, discovery_context
     FROM addie_knowledge
     WHERE source_type = 'community'
       AND fetch_status = 'pending'
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit]
  );

  if (result.rows.length === 0) {
    logger.debug('No community articles need processing');
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  logger.debug({ count: result.rows.length }, 'Processing pending community articles');

  // Fetch active notification channels for routing decisions
  const activeChannels = await getActiveChannels();
  const channelsForRouting: ChannelForRouting[] = activeChannels.map(ch => ({
    slack_channel_id: ch.slack_channel_id,
    name: ch.name,
    description: ch.description,
  }));

  let succeeded = 0;
  let failed = 0;

  for (const article of result.rows) {
    try {
      // Fetch content
      const content = await fetchUrlContent(article.source_url);

      if (content.length < 100) {
        logger.warn({ id: article.id }, 'Community article content too short');
        await query(
          `UPDATE addie_knowledge SET fetch_status = 'failed', updated_at = NOW() WHERE id = $1`,
          [article.id]
        );
        failed++;
        continue;
      }

      // Generate analysis with channel routing
      const analysis = await generateAnalysis(
        article.title || 'Shared article',
        content,
        article.source_url,
        channelsForRouting
      );

      // Update knowledge entry
      await query(
        `UPDATE addie_knowledge SET
           title = $2,
           content = $3,
           summary = $4,
           key_insights = $5,
           addie_notes = $6,
           relevance_tags = $7,
           quality_score = $8,
           mentions_agentic = $9,
           mentions_adcp = $10,
           notification_channel_ids = $11,
           fetch_status = 'success',
           last_fetched_at = NOW(),
           updated_at = NOW()
         WHERE id = $1`,
        [
          article.id,
          extractTitleFromContent(content) || article.title || 'Shared article',
          content,
          analysis.summary,
          analysis.key_insights ? JSON.stringify(analysis.key_insights) : null,
          analysis.addie_notes,
          analysis.relevance_tags,
          analysis.quality_score,
          checkMentionsAgentic(content, '', analysis.relevance_tags),
          checkMentionsAdcp(content, ''),
          analysis.notification_channels || [],
        ]
      );

      logger.debug(
        { id: article.id, quality: analysis.quality_score, url: article.source_url },
        'Successfully processed community article'
      );
      succeeded++;
    } catch (error) {
      logger.error({ error, id: article.id }, 'Failed to process community article');
      await query(
        `UPDATE addie_knowledge SET fetch_status = 'failed', updated_at = NOW() WHERE id = $1`,
        [article.id]
      );
      failed++;
    }

    // Small delay between requests
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return { processed: result.rows.length, succeeded, failed };
}

/**
 * Extract a title from article content (first heading or first sentence)
 */
function extractTitleFromContent(content: string): string | null {
  // Try to find a heading at the start
  const lines = content.split('\n').filter(l => l.trim());
  if (lines.length > 0) {
    const firstLine = lines[0].trim();
    if (firstLine.length > 10 && firstLine.length < 200) {
      return firstLine;
    }
  }
  return null;
}

/**
 * Process pending RSS perspectives in batches
 * Called by background job alongside processPendingResources
 */
export async function processRssPerspectives(options: {
  limit?: number;
} = {}): Promise<{ processed: number; succeeded: number; failed: number }> {
  const perspectives = await getPendingRssPerspectives(options.limit ?? 5);

  if (perspectives.length === 0) {
    logger.debug('No RSS perspectives need processing');
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  logger.debug({ count: perspectives.length }, 'Processing pending RSS perspectives');

  // Fetch active notification channels for routing decisions
  const activeChannels = await getActiveChannels();
  const channelsForRouting: ChannelForRouting[] = activeChannels.map(ch => ({
    slack_channel_id: ch.slack_channel_id,
    name: ch.name,
    description: ch.description,
  }));

  let succeeded = 0;
  let failed = 0;

  for (const perspective of perspectives) {
    const success = await processRssPerspective(perspective, channelsForRouting);
    if (success) {
      succeeded++;
    } else {
      failed++;
    }

    // Small delay between requests to be respectful
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  return { processed: perspectives.length, succeeded, failed };
}
