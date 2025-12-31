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
  getExternalRepoStats,
  getConfiguredRepos,
} from './external-repos.js';
import { searchSlackMessages, isSlackConfigured } from '../../slack/client.js';
import { AddieDatabase } from '../../db/addie-db.js';
import { queueWebSearchResult } from '../services/content-curator.js';

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
    if (repoStats.length > 0) {
      logger.info(
        {
          repos: repoStats.map((r) => `${r.id}(${r.docCount})`).join(', '),
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
      'Search the official AdCP documentation at docs.adcontextprotocol.org. Use this for questions about the AdCP protocol, tasks, schemas, and implementation guides. Returns full content with source URLs for citation.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query - use relevant keywords from the question',
        },
        category: {
          type: 'string',
          description: 'Optional category filter (media-buy, signals, creative, intro, reference)',
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
    name: 'search_repos',
    description:
      'Search indexed external GitHub repositories including: AdCP Sales Agent (how to set up and run a sales agent for publishers), AdCP JavaScript Client, and AdCP Python Client. Use this for implementation examples, SDK usage, setup guides, and changelogs for these projects.',
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
            'Optional filter to search only a specific repo (salesagent, adcp-client, adcp-client-python)',
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
      'Search Slack messages from public channels in the AAO workspace. Use this when you need community discussions, Q&A threads, or real-world implementation examples. Recent messages are searched instantly from local index; older messages may fall back to live API (slower). Cite the Slack permalink when using information from results.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query - keywords or phrases to find in Slack messages',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default 5, max 10)',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'search_resources',
    description:
      'Search curated external resources (articles, blog posts, industry content) that have been indexed with summaries and contextual analysis. Use this for industry trends, competitor info, and external perspectives on agentic advertising.',
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
];

/**
 * Tool handlers
 */
export function createKnowledgeToolHandlers(): Map<
  string,
  (input: Record<string, unknown>) => Promise<string>
> {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

  handlers.set('search_docs', async (input) => {
    const query = input.query as string;
    const category = input.category as string | undefined;
    const limit = (input.limit as number) || 3;

    const results = searchDocsContent(query, { category, limit });

    if (results.length === 0) {
      return `No documentation found for: "${query}"${category ? ` in category: ${category}` : ''}\n\nTry using web_search for external sources or search_slack for community discussions.`;
    }

    // Return full content with source URLs for citation
    const formatted = results
      .map((doc, i) => {
        // Truncate content if too long
        const maxContentLength = 2000;
        let content = doc.content;
        if (content.length > maxContentLength) {
          content = content.substring(0, maxContentLength) + '\n\n... [truncated - see full doc at source URL]';
        }

        return `## ${i + 1}. ${doc.title}
**Category:** ${doc.category}
**Source:** ${doc.sourceUrl}

${content}`;
      })
      .join('\n\n---\n\n');

    return `Found ${results.length} documentation pages:\n\n${formatted}\n\n**Remember to cite the source URL when using this information.**`;
  });

  handlers.set('search_repos', async (input) => {
    const query = input.query as string;
    const repoId = input.repo_id as string | undefined;
    const limit = (input.limit as number) || 3;

    if (!isExternalReposReady()) {
      return 'External repositories are not yet indexed. Try search_docs for official documentation or web_search for external sources.';
    }

    const results = searchExternalDocs(query, { repoId, limit });

    if (results.length === 0) {
      const repos = getConfiguredRepos();
      const repoList = repos.map((r) => `- ${r.name} (${r.id})`).join('\n');
      return `No results found for: "${query}"${repoId ? ` in repo: ${repoId}` : ''}\n\nAvailable repos:\n${repoList}\n\nTry search_docs for official documentation or web_search for external sources.`;
    }

    const formatted = results
      .map((doc, i) => {
        // Truncate content if too long
        const maxContentLength = 2000;
        let content = doc.content;
        if (content.length > maxContentLength) {
          content =
            content.substring(0, maxContentLength) + '\n\n... [truncated - see full doc at source URL]';
        }

        return `## ${i + 1}. ${doc.title}
**Repo:** ${doc.repoName}
**Path:** ${doc.path}
**Source:** ${doc.sourceUrl}

${content}`;
      })
      .join('\n\n---\n\n');

    return `Found ${results.length} documents from external repos:\n\n${formatted}\n\n**Remember to cite the source URL when using this information.**`;
  });

  handlers.set('search_slack', async (input) => {
    const query = input.query as string;
    const limit = Math.min((input.limit as number) || 5, 10);

    try {
      // First, try local database search (instant, ~100ms)
      const localResults = await addieDb.searchSlackMessages(query, { limit });

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

        return `Found ${localResults.length} Slack messages (from local index):\n\n${formatted}\n\n**Remember to cite the Slack permalink when using this information.**`;
      }

      // If no local results and Slack API is configured, fall back to live API search
      // Note: This is slow (~5-6 seconds) but covers historical messages not yet indexed
      if (isSlackConfigured()) {
        logger.info({ query }, 'No local Slack results, falling back to live API search');
        const apiResults = await searchSlackMessages(query, { count: limit });

        if (apiResults.matches.length === 0) {
          return `No Slack discussions found for: "${query}"\n\nTry search_docs for documentation or web_search for external sources.`;
        }

        const formatted = apiResults.matches
          .map((match, i) => {
            // Clean up the text (remove extra whitespace, truncate)
            const cleanText = match.text
              .replace(/\s+/g, ' ')
              .trim()
              .substring(0, 500);
            const truncated = cleanText.length < match.text.length ? '...' : '';

            return `### ${i + 1}. #${match.channel.name} - @${match.username}
"${cleanText}${truncated}"

**Source:** ${match.permalink}`;
          })
          .join('\n\n');

        return `Found ${apiResults.total} Slack messages (showing ${apiResults.matches.length}):\n\n${formatted}\n\n**Remember to cite the Slack permalink when using this information.**`;
      }

      return `No Slack discussions found for: "${query}"\n\nTry search_docs for documentation or web_search for external sources.`;
    } catch (error) {
      logger.error({ error, query }, 'Addie: Slack search failed');
      return `Slack search failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
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

      // Queue for indexing
      const id = await queueWebSearchResult({
        url,
        title,
        searchQuery: reason, // Use reason as context
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

  return handlers;
}
