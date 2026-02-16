/**
 * Addie Knowledge Search
 *
 * Searches public knowledge sources:
 * 1. Indexed Mintlify docs (read from filesystem at startup)
 * 2. External GitHub repos (sales-agent, client libraries, etc.)
 * 3. Slack community discussions
 * 4. Web search (handled by Claude's built-in tool)
 *
 * Note: We intentionally don't have a private knowledge database.
 * All knowledge should be publicly available so any agent can find it.
 * When knowledge gaps are identified, the fix is to publish content,
 * not add to a private store.
 */

import { logger } from '../../logger.js';
import type { AddieTool } from '../types.js';
import {
  initializeDocsIndex,
  isDocsIndexReady,
  searchDocs,
  getDocById,
  getDocCategories,
  getDocCount,
  type IndexedDoc,
} from './docs-indexer.js';
import {
  initializeExternalRepos,
  isExternalReposReady,
  searchExternalDocs,
  searchExternalHeadings,
  getExternalRepoStats,
  getExternalHeadingCount,
  getConfiguredRepos,
} from './external-repos.js';
// Note: Slack's search.messages API requires a user token (xoxp-), not a bot token (xoxb-).
// Bot tokens don't support this scope. We rely on local database search instead,
// which is populated by channel history indexing.
import { AddieDatabase } from '../../db/addie-db.js';
import { queueWebSearchResult } from '../services/content-curator.js';
import { findChannelWithAccess, getAccessiblePrivateChannelIds } from '../../slack/client.js';

const addieDb = new AddieDatabase();

let initialized = false;

/**
 * Initialize knowledge search
 * - Indexes docs from filesystem
 * - Clones/updates and indexes external repos
 */
export async function initializeKnowledgeSearch(): Promise<void> {
  logger.info('Addie: Initializing knowledge search');

  // Index docs from filesystem
  try {
    await initializeDocsIndex();
    const docCount = getDocCount();
    const categories = getDocCategories();
    logger.info(
      {
        docCount,
        categories: categories.map((c) => `${c.category}(${c.count})`).join(', '),
      },
      'Addie: Docs index ready'
    );
  } catch (error) {
    logger.warn({ error }, 'Addie: Failed to index docs');
  }

  // Clone/update and index external repos (sales-agent, client libraries, etc.)
  try {
    await initializeExternalRepos();
    const repoStats = getExternalRepoStats();
    const totalHeadings = getExternalHeadingCount();
    if (repoStats.length > 0) {
      logger.info(
        {
          repos: repoStats.map((r) => `${r.id}(${r.docCount} docs, ${r.headingCount} sections)`).join(', '),
          totalHeadings,
        },
        'Addie: External repos index ready'
      );
    }
  } catch (error) {
    logger.warn({ error }, 'Addie: Failed to index external repos');
  }

  initialized = true;
}

/**
 * Check if knowledge search is ready
 */
export function isKnowledgeReady(): boolean {
  return initialized;
}

/**
 * Search result with source citation
 */
export interface DocsSearchResult {
  id: string;
  title: string;
  category: string;
  headline: string;
  sourceUrl: string;
  content: string;
}

/**
 * Search indexed documentation
 * Returns results with full content and source URLs for citation
 */
export function searchDocsContent(
  query: string,
  options: { category?: string; limit?: number } = {}
): DocsSearchResult[] {
  if (!initialized || !isDocsIndexReady()) {
    return [];
  }

  const limit = options.limit ?? 5;
  const results = searchDocs(query, { category: options.category, limit });

  return results.map((doc) => {
    // Create a headline from first 200 chars (skip headings)
    const headline = doc.content
      .replace(/^#.*$/gm, '')
      .replace(/\n+/g, ' ')
      .trim()
      .substring(0, 200);

    return {
      id: doc.id,
      title: doc.title,
      category: doc.category,
      headline: headline + (headline.length >= 200 ? '...' : ''),
      sourceUrl: doc.sourceUrl,
      content: doc.content,
    };
  });
}

/**
 * Tool definitions for Claude
 *
 * We provide search tools and a bookmark tool:
 * 1. search_docs - Search our Mintlify documentation (fast, local, authoritative for AdCP)
 * 2. search_repos - Search external GitHub repos (sales-agent, client libraries)
 * 3. search_slack - Search community discussions (real-world context)
 * 4. search_resources - Search curated external resources with Addie's analysis
 * 5. bookmark_resource - Save useful web content to knowledge base for future reference
 *
 * Web search is provided by Claude's built-in tool for external sources.
 */
export const KNOWLEDGE_TOOLS: AddieTool[] = [
  {
    name: 'search_docs',
    description:
      'Search the official AdCP documentation. Returns excerpts with source URLs. IMPORTANT: Use ONE well-crafted search with specific keywords rather than multiple searches. For detailed content, use get_doc with the doc ID from results.',
    usage_hints: 'use for learning, understanding concepts, "how does X work?", "what is X?", "explain X"',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query - use specific keywords (e.g., "media buy workflow" not "how does buying work")',
        },
        category: {
          type: 'string',
          description: 'Optional category filter (media-buy, signals, creative, intro, reference)',
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default 3, max 5). Use fewer results for simple questions.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_doc',
    description:
      'Get the full content of a specific documentation page by ID. Use this after search_docs when you need complete details from a document.',
    usage_hints: 'use after search_docs to read complete doc details',
    input_schema: {
      type: 'object',
      properties: {
        doc_id: {
          type: 'string',
          description: 'The document ID from search_docs results',
        },
      },
      required: ['doc_id'],
    },
  },
  {
    name: 'search_repos',
    description:
      'Search indexed external GitHub repositories for ad tech specifications and protocols. Includes: ' +
      'AdCP (core protocol spec, sales agent, signals agent, JS/Python clients), ' +
      'A2A (Google Agent-to-Agent protocol and samples), ' +
      'MCP (Model Context Protocol spec, TypeScript/Python SDKs, reference servers), ' +
      'IAB Tech Lab specs (OpenRTB 2.x/3.0, AdCOM, OpenDirect, ARTF, UCP, GPP, TCF, US Privacy, UID2, VAST, ads.cert), ' +
      'Prebid (full documentation site with configuration guides, bidder adapter docs, ad ops workflows, GAM integration, troubleshooting, Prebid Mobile, and video; plus Prebid.js source with module docs, and Prebid Server source), ' +
      'and LangGraph. ' +
      'Use this for protocol details, spec comparisons, implementation examples, and SDK usage.',
    usage_hints:
      'use for: OpenRTB questions, A2A protocol, MCP implementation, IAB specs, Prebid configuration/adapters/troubleshooting/GAM, TCF/GPP consent, UID2, salesagent setup, SDK usage',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query - use relevant keywords from the question',
        },
        repo_id: {
          type: 'string',
          description:
            'Optional filter to search only a specific repo: adcp, salesagent, signals-agent, adcp-client, adcp-client-python, a2a, a2a-samples, mcp-spec, mcp-typescript-sdk, mcp-python-sdk, mcp-servers, iab-artf, iab-ucp, iab-openrtb2, iab-openrtb3, iab-adcom, iab-opendirect, iab-gpp, iab-tcf, iab-usprivacy, iab-uid2-docs, iab-vast, iab-adscert, prebid-js, prebid-server, prebid-docs, langgraph',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default 3)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_slack',
    description:
      'Search Slack messages from public channels in the AAO workspace. Use this when you need community discussions, Q&A threads, or real-world implementation examples. When asked about a specific channel or working group (e.g., "Governance working group"), use the channel parameter to filter results. When asked to summarize discussions, search for relevant keywords then synthesize the results. Cite the Slack permalink when using information from results.',
    usage_hints: 'use for community Q&A, "what did someone say about X?", channel summaries, working group discussions',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query - keywords or phrases to find in Slack messages. Use broad terms when summarizing a channel (e.g., "governance" for governance discussions).',
        },
        channel: {
          type: 'string',
          description: 'Optional channel name to filter results (e.g., "governance-wg", "general"). Partial matches work.',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default 10, max 25 for summaries)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_channel_activity',
    description:
      'Get recent messages from a specific Slack channel. Use this when asked to summarize channel activity, see what a working group has been discussing, or get an overview of conversations in a channel. Returns messages sorted by recency. After getting results, synthesize them into a summary for the user.',
    usage_hints: 'use for "summarize the governance channel", "what has the X working group been discussing?", channel overviews',
    input_schema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          description: 'Channel name to get activity from (e.g., "governance-wg", "general"). Partial matches work.',
        },
        days: {
          type: 'number',
          description: 'How many days back to look (default 30, max 90)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of messages to return (default 25, max 50)',
        },
      },
      required: ['channel'],
    },
  },
  {
    name: 'search_resources',
    description:
      'Search curated external resources (articles, blog posts, industry content) that have been indexed with summaries and contextual analysis. Use this for industry trends, competitor info, and external perspectives on agentic advertising.',
    usage_hints: 'use for industry trends, competitor info, external perspectives on agentic advertising',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query - keywords or phrases',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by relevance tags (e.g., mcp, a2a, industry-trend, competitor)',
        },
        min_quality: {
          type: 'number',
          description: 'Minimum quality score 1-5 (default: no filter)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default 5)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'bookmark_resource',
    description:
      'Save a useful web resource to the knowledge base for future reference. Use this when you find valuable external content during web search that would be helpful for future questions. The content will be fetched, summarized, and indexed.',
    usage_hints: 'use when finding useful external content to save for future reference',
    input_schema: {
      type: 'object',
      properties: {
        url: {
          type: 'string',
          description: 'The URL of the resource to bookmark',
        },
        title: {
          type: 'string',
          description: 'Title of the resource',
        },
        reason: {
          type: 'string',
          description: 'Brief explanation of why this resource is valuable (helps with categorization)',
        },
      },
      required: ['url', 'title', 'reason'],
    },
  },
  {
    name: 'get_recent_news',
    description:
      'Get recent news and articles about ad tech and agentic advertising from curated industry feeds. Returns articles sorted by recency with summaries and analysis. Use this when users ask "what\'s happening in the news?", "what\'s new in ad tech?", or "what have we learned lately?"',
    usage_hints: 'use for recent news, "what\'s happening?", "what\'s new?", industry updates, trending topics',
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'How many days back to look (default 7, max 30)',
        },
        topic: {
          type: 'string',
          description: 'Optional topic filter (e.g., "agentic advertising", "CTV", "retail media")',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by relevance tags (e.g., mcp, a2a, industry-trend, competitor)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of articles (default 10, max 20)',
        },
      },
      required: [],
    },
  },
];

/**
 * Extract a smart excerpt that shows content around query matches
 * instead of just the first N characters
 */
function extractSmartExcerpt(content: string, query: string, maxLength: number = 500): string {
  // Clean content: remove frontmatter, code blocks, and normalize whitespace
  let cleanContent = content
    .replace(/^---[\s\S]*?---\n?/, '') // Remove frontmatter
    .replace(/```[\s\S]*?```/g, '[code block]') // Collapse code blocks
    .replace(/\n{3,}/g, '\n\n'); // Normalize whitespace

  // Extract query terms (words > 2 chars, no common words)
  const stopWords = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
    'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'were', 'they', 'this', 'that',
    'with', 'will', 'from', 'what', 'when', 'make', 'like', 'how', 'does', 'work']);
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(term => term.length > 2 && !stopWords.has(term));

  if (queryTerms.length === 0) {
    // No meaningful query terms, fall back to first paragraph after any heading
    const firstParagraph = cleanContent
      .replace(/^#.*$/gm, '')
      .split(/\n\n+/)
      .find(p => p.trim().length > 50);
    if (firstParagraph) {
      return firstParagraph.trim().substring(0, maxLength) + (firstParagraph.length > maxLength ? '...' : '');
    }
    return cleanContent.substring(0, maxLength) + '...';
  }

  // Split into paragraphs (including headings as context)
  const paragraphs = cleanContent.split(/\n\n+/).filter(p => p.trim().length > 0);

  // Score each paragraph by how many query terms it contains
  const scoredParagraphs = paragraphs.map((para, index) => {
    const lowerPara = para.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      // Count occurrences of each term
      const regex = new RegExp(term, 'gi');
      const matches = lowerPara.match(regex);
      if (matches) {
        score += matches.length;
        // Bonus for exact word match (not substring)
        const wordRegex = new RegExp(`\\b${term}\\b`, 'gi');
        const wordMatches = lowerPara.match(wordRegex);
        if (wordMatches) {
          score += wordMatches.length * 2;
        }
      }
    }
    // Slight bonus for earlier paragraphs (they're often more relevant)
    const positionBonus = Math.max(0, (10 - index) * 0.1);
    return { para, score: score + positionBonus, index };
  });

  // Get best matching paragraphs
  const bestParagraphs = scoredParagraphs
    .filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (bestParagraphs.length === 0) {
    // No matches found, return first substantive paragraph
    const firstParagraph = paragraphs.find(p => p.trim().length > 50 && !p.startsWith('#'));
    if (firstParagraph) {
      return firstParagraph.trim().substring(0, maxLength) + (firstParagraph.length > maxLength ? '...' : '');
    }
    return cleanContent.substring(0, maxLength) + '...';
  }

  // Build excerpt from best paragraphs, respecting maxLength
  let excerpt = '';
  const usedIndices = new Set<number>();

  for (const { para, index } of bestParagraphs) {
    if (usedIndices.has(index)) continue;

    // Include context: preceding heading if any
    let section = '';
    for (let i = index - 1; i >= 0; i--) {
      if (paragraphs[i].startsWith('#')) {
        section = paragraphs[i] + '\n\n';
        usedIndices.add(i);
        break;
      }
      if (paragraphs[i].trim().length > 20) break; // Stop if we hit another paragraph
    }

    const addition = section + para;
    if (excerpt.length + addition.length > maxLength && excerpt.length > 0) {
      break; // Would exceed limit
    }
    excerpt += (excerpt ? '\n\n' : '') + addition;
    usedIndices.add(index);
  }

  // Truncate if still too long
  if (excerpt.length > maxLength) {
    excerpt = excerpt.substring(0, maxLength);
    // Try to end at a sentence
    const lastPeriod = excerpt.lastIndexOf('. ');
    if (lastPeriod > maxLength * 0.6) {
      excerpt = excerpt.substring(0, lastPeriod + 1);
    }
    excerpt += '...';
  }

  return excerpt || cleanContent.substring(0, maxLength) + '...';
}

/**
 * Tool handlers
 * @param slackUserId - Optional Slack user ID for access control on private channels
 */
export function createKnowledgeToolHandlers(slackUserId?: string): Map<
  string,
  (input: Record<string, unknown>) => Promise<string>
> {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

  handlers.set('search_docs', async (input) => {
    const startTime = Date.now();
    const query = input.query as string;
    const category = input.category as string | undefined;
    const limit = Math.min((input.limit as number) || 3, 5);

    const results = searchDocsContent(query, { category, limit });
    const latencyMs = Date.now() - startTime;

    // Log search for pattern analysis (async, don't block response)
    addieDb.logSearch({
      query,
      tool_name: 'search_docs',
      category,
      limit_requested: limit,
      results_count: results.length,
      result_ids: results.map(r => r.id),
      search_latency_ms: latencyMs,
      channel: 'tool',
    }).catch(err => logger.warn({ err }, 'Failed to log search'));

    if (results.length === 0) {
      return `No documentation found for: "${query}"${category ? ` in category: ${category}` : ''}\n\nTry using web_search for external sources or search_slack for community discussions.`;
    }

    // Return smart excerpts that focus on content matching the query
    const formatted = results
      .map((doc, i) => {
        const excerpt = extractSmartExcerpt(doc.content, query, 500);

        return `## ${i + 1}. ${doc.title}
**ID:** ${doc.id}
**Category:** ${doc.category}
**Source:** ${doc.sourceUrl}

${excerpt}

[Use get_doc for full content]`;
      })
      .join('\n\n---\n\n');

    return `Found ${results.length} docs. Use get_doc with an ID for full content:\n\n${formatted}`;
  });

  handlers.set('get_doc', async (input) => {
    const docId = input.doc_id as string;

    if (!initialized || !isDocsIndexReady()) {
      return 'Documentation index not ready.';
    }

    const doc = getDocById(docId);
    if (!doc) {
      return `Document not found: "${docId}". Use search_docs to find available documents.`;
    }

    // Return full content (but cap at 4000 chars to prevent massive responses)
    const maxLength = 4000;
    let content = doc.content;
    if (content.length > maxLength) {
      content = content.substring(0, maxLength) + '\n\n... [content truncated at 4000 chars]';
    }

    return `# ${doc.title}

**Source:** ${doc.sourceUrl}
**Category:** ${doc.category}

${content}`;
  });

  handlers.set('search_repos', async (input) => {
    const startTime = Date.now();
    const query = input.query as string;
    const repoId = input.repo_id as string | undefined;
    const limit = Math.min((input.limit as number) || 3, 5);

    if (!isExternalReposReady()) {
      return 'External repositories are not yet indexed. Try search_docs for official documentation or web_search for external sources.';
    }

    // Validate repo_id if provided
    if (repoId) {
      const validRepoIds = getConfiguredRepos().map((r) => r.id);
      if (!validRepoIds.includes(repoId)) {
        return `Invalid repo_id: "${repoId}". Valid options: ${validRepoIds.join(', ')}`;
      }
    }

    // Search both headings (section-level) and docs (file-level)
    // Heading search is better for finding specific protocol details
    const headingResults = searchExternalHeadings(query, { repoId, limit });
    const docResults = searchExternalDocs(query, { repoId, limit });
    const latencyMs = Date.now() - startTime;

    // Combine results, preferring headings but including docs for context
    // Dedupe by checking if a doc's sections are already represented
    const seenDocIds = new Set(headingResults.map(h => h.doc_id));
    const additionalDocs = docResults.filter(d => !seenDocIds.has(d.id)).slice(0, Math.max(1, limit - headingResults.length));

    const totalResults = headingResults.length + additionalDocs.length;

    // Log search for pattern analysis
    addieDb.logSearch({
      query,
      tool_name: 'search_repos',
      category: repoId,
      limit_requested: limit,
      results_count: totalResults,
      result_ids: [...headingResults.map(h => h.id), ...additionalDocs.map(d => d.id)],
      search_latency_ms: latencyMs,
      channel: 'tool',
    }).catch(err => logger.warn({ err }, 'Failed to log search'));

    if (totalResults === 0) {
      const repos = getConfiguredRepos();
      const repoList = repos.map((r) => `- ${r.name} (${r.id})`).join('\n');
      return `No results found for: "${query}"${repoId ? ` in repo: ${repoId}` : ''}\n\nAvailable repos:\n${repoList}\n\nTry search_docs for official documentation or web_search for external sources.`;
    }

    // Format heading results (section-level, more specific)
    const headingFormatted = headingResults.map((heading, i) => {
      const breadcrumb = heading.parent_headings.length > 0
        ? `${heading.parent_headings.join(' > ')} > ${heading.title}`
        : heading.title;

      // For headings, show the full content (it's already scoped to one section)
      const content = heading.content.length > 800
        ? heading.content.substring(0, 800) + '...'
        : heading.content;

      return `## ${i + 1}. ${breadcrumb}
**Repo:** ${heading.repoName}
**Path:** ${heading.path}
**Source:** ${heading.sourceUrl}

${content}`;
    });

    // Format additional doc results (file-level, for context)
    const docFormatted = additionalDocs.map((doc, i) => {
      const excerpt = extractSmartExcerpt(doc.content, query, 500);

      return `## ${headingResults.length + i + 1}. ${doc.title}
**Repo:** ${doc.repoName}
**Path:** ${doc.path}
**Source:** ${doc.sourceUrl}

${excerpt}`;
    });

    const allFormatted = [...headingFormatted, ...docFormatted].join('\n\n---\n\n');
    const resultType = headingResults.length > 0 ? 'sections' : 'docs';

    return `Found ${totalResults} ${resultType}:\n\n${allFormatted}`;
  });

  handlers.set('search_slack', async (input) => {
    const searchQuery = input.query as string;
    const channel = input.channel as string | undefined;
    const limit = Math.min((input.limit as number) || 10, 25);

    try {
      // Check access if searching a specific channel and we have user context
      if (channel && slackUserId) {
        const accessResult = await findChannelWithAccess(channel, slackUserId);
        if (accessResult && !accessResult.hasAccess) {
          return `Cannot search #${accessResult.channel.name}: ${accessResult.reason || 'Access denied'}.\n\nPrivate channel messages are only accessible to channel members.`;
        }
      }

      // Get accessible private channel IDs for access filtering
      // This ensures search results don't leak private channel content
      let accessiblePrivateChannelIds: string[] | undefined;
      if (slackUserId) {
        accessiblePrivateChannelIds = await getAccessiblePrivateChannelIds(slackUserId);
      }

      // Search local database with optional channel filter and access control
      const localResults = await addieDb.searchSlackMessages(searchQuery, {
        limit,
        channel,
        accessiblePrivateChannelIds,
      });

      if (localResults.length > 0) {
        const formatted = localResults
          .map((match, i) => {
            // Clean up the text (remove extra whitespace, truncate)
            const cleanText = match.text
              .replace(/\s+/g, ' ')
              .trim()
              .substring(0, 500);
            const truncated = cleanText.length < match.text.length ? '...' : '';

            return `### ${i + 1}. #${match.channel_name} - @${match.username}
"${cleanText}${truncated}"

**Source:** ${match.permalink}`;
          })
          .join('\n\n');

        const channelNote = channel ? ` in channels matching "${channel}"` : '';
        return `Found ${localResults.length} Slack messages${channelNote}:\n\n${formatted}\n\n**Remember to cite the Slack permalink when using this information.**`;
      }

      // No local results found - provide helpful guidance
      const channelNote = channel ? ` in channel "${channel}"` : '';
      return `No Slack discussions found for: "${searchQuery}"${channelNote}\n\nTry:\n- Broader search terms\n- Removing the channel filter\n- search_docs for documentation`;
    } catch (error) {
      logger.error({ error, query: searchQuery, channel }, 'Addie: Slack search failed');
      return `Slack search failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  });

  handlers.set('get_channel_activity', async (input) => {
    const channel = input.channel as string;
    const days = input.days as number | undefined;
    const limit = input.limit as number | undefined;

    try {
      // Check access if we have user context
      if (slackUserId) {
        const accessResult = await findChannelWithAccess(channel, slackUserId);
        if (accessResult && !accessResult.hasAccess) {
          return `Cannot access #${accessResult.channel.name}: ${accessResult.reason || 'Access denied'}.\n\nPrivate channel activity is only accessible to channel members.`;
        }
        // If it's a private channel and not indexed, inform the user
        if (accessResult && accessResult.channel.is_private) {
          const messages = await addieDb.getChannelActivity(channel, { days, limit });
          if (messages.length === 0) {
            return `No indexed activity found for private channel #${accessResult.channel.name}.\n\nPrivate channels are indexed but may not have historical data. Recent messages should appear after they are sent.`;
          }
        }
      }

      const messages = await addieDb.getChannelActivity(channel, { days, limit });

      if (messages.length === 0) {
        return `No recent activity found in channels matching "${channel}".\n\nThis could mean:\n- The channel name might be different (try partial matches like "govern" for "governance-wg")\n- No messages in the last ${days ?? 30} days\n- The channel may not be indexed yet`;
      }

      // Group messages by user to help with "who's most active" analysis
      const userCounts = new Map<string, number>();
      for (const msg of messages) {
        userCounts.set(msg.username, (userCounts.get(msg.username) || 0) + 1);
      }
      const topUsers = [...userCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([name, count]) => `@${name} (${count})`)
        .join(', ');

      const formatted = messages
        .map((msg, i) => {
          const cleanText = msg.text
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 400);
          const truncated = cleanText.length < msg.text.length ? '...' : '';
          const date = new Date(msg.created_at).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
          });

          return `### ${i + 1}. @${msg.username} (${date})
"${cleanText}${truncated}"

**Source:** ${msg.permalink}`;
        })
        .join('\n\n');

      const channelName = messages[0]?.channel_name || channel;
      return `## Recent activity in #${channelName}

**${messages.length} messages** from the last ${days ?? 30} days
**Most active:** ${topUsers}

---

${formatted}

---

**When summarizing:** Focus on key themes, decisions, and who contributed to each topic. Cite specific messages using their Slack permalinks.`;
    } catch (error) {
      logger.error({ error, channel }, 'Addie: get_channel_activity failed');
      return `Failed to get channel activity: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  });

  handlers.set('search_resources', async (input) => {
    const query = input.query as string;
    const limit = Math.min((input.limit as number) || 5, 10);
    const tags = input.tags as string[] | undefined;
    const minQuality = input.min_quality as number | undefined;

    try {
      const results = await addieDb.searchCuratedResources(query, {
        limit,
        tags,
        minQuality,
      });

      if (results.length === 0) {
        return `No curated resources found for: "${query}"\n\nTry search_docs for official documentation or web_search for live web results.`;
      }

      const formatted = results
        .map((resource, i) => {
          const qualityStars = resource.quality_score
            ? '★'.repeat(resource.quality_score) + '☆'.repeat(5 - resource.quality_score)
            : 'Not rated';
          const tagsDisplay = resource.relevance_tags?.length
            ? resource.relevance_tags.join(', ')
            : 'No tags';

          return `### ${i + 1}. ${resource.title}
**Quality:** ${qualityStars}
**Tags:** ${tagsDisplay}
**URL:** ${resource.source_url}

${resource.summary || resource.headline}

${resource.addie_notes ? `**Addie's Take:** ${resource.addie_notes}` : ''}`;
        })
        .join('\n\n---\n\n');

      return `Found ${results.length} curated resources:\n\n${formatted}\n\n**Remember to cite the source URL when using this information.**`;
    } catch (error) {
      logger.error({ error, query }, 'Addie: Resource search failed');
      return `Resource search failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  });

  handlers.set('bookmark_resource', async (input) => {
    const url = input.url as string;
    const title = input.title as string;
    const reason = input.reason as string;

    // Validate URL
    try {
      new URL(url);
    } catch {
      return `Invalid URL: "${url}". Please provide a valid URL.`;
    }

    try {
      // Check if already indexed
      const isIndexed = await addieDb.isUrlIndexed(url);
      if (isIndexed) {
        return `This resource is already in the knowledge base: ${url}`;
      }

      // Queue for indexing (no user context in default handler)
      const id = await queueWebSearchResult({
        url,
        title,
        searchQuery: reason, // Use reason as context
        created_by: 'system', // Default when no user context available
      });

      if (id === 0) {
        return `Resource was already queued or could not be added: ${url}`;
      }

      logger.info({ url, title, reason }, 'Addie bookmarked resource');
      return `Bookmarked "${title}" for indexing. The content will be fetched, summarized, and added to the knowledge base shortly. You can search for it later using search_resources.`;
    } catch (error) {
      logger.error({ error, url }, 'Addie: Bookmark failed');
      return `Failed to bookmark resource: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  });

  handlers.set('get_recent_news', async (input) => {
    const days = Math.min((input.days as number) || 7, 30);
    const limit = Math.min((input.limit as number) || 10, 20);
    const topic = input.topic as string | undefined;
    const tags = input.tags as string[] | undefined;

    try {
      const results = await addieDb.getRecentNews({
        days,
        limit,
        topic,
        tags,
        minQuality: 3, // Only show quality content
      });

      if (results.length === 0) {
        const topicHint = topic ? ` about "${topic}"` : '';
        const tagHint = tags?.length ? ` tagged with ${tags.join(', ')}` : '';
        return `No recent news found${topicHint}${tagHint} in the last ${days} days.\n\nTry:\n- Expanding the time range (days parameter)\n- Removing topic/tag filters\n- Using web_search for live results`;
      }

      const formatted = results
        .map((article, i) => {
          const qualityStars = article.quality_score
            ? '★'.repeat(article.quality_score) + '☆'.repeat(5 - article.quality_score)
            : 'Not rated';
          const tagsDisplay = article.relevance_tags?.length
            ? article.relevance_tags.join(', ')
            : 'No tags';
          const dateStr = new Date(article.last_fetched_at).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
          });

          return `### ${i + 1}. ${article.title}
**Date:** ${dateStr} | **Quality:** ${qualityStars}
**Tags:** ${tagsDisplay}
**URL:** ${article.source_url}

${article.summary || 'No summary available.'}

${article.addie_notes ? `**Addie's Take:** ${article.addie_notes}` : ''}`;
        })
        .join('\n\n---\n\n');

      const topicNote = topic ? ` about "${topic}"` : '';
      return `Found ${results.length} recent articles${topicNote} from the last ${days} days:\n\n${formatted}\n\n**Remember to cite the source URL when sharing this information.**`;
    } catch (error) {
      logger.error({ error }, 'Addie: get_recent_news failed');
      return `Failed to fetch recent news: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  });

  return handlers;
}

/**
 * Create a user-scoped bookmark_resource handler
 * Used by Slack handlers to attribute bookmarks to the user who created them
 */
export function createUserScopedBookmarkHandler(
  slackUserId: string
): (input: Record<string, unknown>) => Promise<string> {
  return async (input) => {
    const url = input.url as string;
    const title = input.title as string;
    const reason = input.reason as string;

    // Validate URL
    try {
      new URL(url);
    } catch {
      return `Invalid URL: "${url}". Please provide a valid URL.`;
    }

    try {
      // Check if already indexed
      const isIndexed = await addieDb.isUrlIndexed(url);
      if (isIndexed) {
        return `This resource is already in the knowledge base: ${url}`;
      }

      // Queue for indexing with user attribution
      const id = await queueWebSearchResult({
        url,
        title,
        searchQuery: reason,
        created_by: slackUserId,
      });

      if (id === 0) {
        return `Resource was already queued or could not be added: ${url}`;
      }

      logger.info({ url, title, reason, slackUserId }, 'Addie bookmarked resource (user-scoped)');
      return `Bookmarked "${title}" for indexing. The content will be fetched, summarized, and added to the knowledge base shortly. You can search for it later using search_resources.`;
    } catch (error) {
      logger.error({ error, url, slackUserId }, 'Addie: User-scoped bookmark failed');
      return `Failed to bookmark resource: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  };
}
