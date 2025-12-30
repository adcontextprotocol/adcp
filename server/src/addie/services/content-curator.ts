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
import { logger } from '../../logger.js';
import { AddieDatabase, type KeyInsight } from '../../db/addie-db.js';

const addieDb = new AddieDatabase();

// Use same model as main Addie assistant
const CURATOR_MODEL = process.env.ADDIE_MODEL || 'claude-sonnet-4-20250514';

/**
 * Fetch URL content and convert to text
 * Uses a simple fetch + HTML to text conversion
 */
async function fetchUrlContent(url: string): Promise<string> {
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

  // Simple HTML to text conversion
  // Remove scripts, styles, and HTML tags
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
    .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
    .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
    .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  // Limit content length to avoid token limits
  const maxLength = 50000;
  if (text.length > maxLength) {
    return text.substring(0, maxLength) + '\n\n[Content truncated...]';
  }

  return text;
}

/**
 * Generate summary and insights using Claude
 */
async function generateAnalysis(
  title: string,
  content: string,
  url: string
): Promise<{
  summary: string;
  key_insights: KeyInsight[];
  addie_notes: string;
  relevance_tags: string[];
  quality_score: number;
}> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const client = new Anthropic({ apiKey });

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
  "addie_notes": "1-2 sentences explaining how this connects to agentic AI, advertising technology, or topics our community cares about. If the content isn't directly about ad tech, explain what broader lessons or context it provides.",
  "relevance_tags": ["tag1", "tag2"],
  "quality_score": 1-5
}

**Relevance tags - choose tags that accurately describe the content:**

Ad Tech & AdCP specific (only use if content is actually about these topics):
- adcp, mcp, a2a, advertising, programmatic, creative, signals, media-buying

General AI & Technology:
- llms, ai-models, ai-agents, machine-learning, responsible-ai, ai-safety, scaling, fine-tuning, prompting, embeddings, rag

Industry & Business:
- industry-news, market-trends, case-study, competitor, startup, enterprise, open-source

Content Type:
- tutorial, documentation, opinion, research, announcement, integration

Other relevant topics:
- privacy, data, apis, protocols, standards, developer-tools, infrastructure

Use 2-5 tags that best describe what the content is actually about. Do NOT force ad-tech tags onto general AI content.

**Quality score (for our knowledge base):**
- 5: Authoritative source, directly relevant to AdCP or agentic advertising
- 4: High quality, relevant to AI agents or advertising technology
- 3: Good quality, useful context for understanding AI or tech landscape
- 2: Decent content but limited relevance to our focus areas
- 1: Low quality or not useful for our community

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
      addie_notes: parsed.addie_notes || '',
      relevance_tags: parsed.relevance_tags || [],
      quality_score: Math.min(5, Math.max(1, parsed.quality_score || 3)),
    };
  } catch {
    // If JSON parsing fails, extract what we can
    logger.warn({ responseText }, 'Failed to parse curator response as JSON');
    return {
      summary: responseText.substring(0, 500),
      key_insights: [],
      addie_notes: '',
      relevance_tags: [],
      quality_score: 3,
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
