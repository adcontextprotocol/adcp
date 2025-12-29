/**
 * Addie Knowledge Search
 *
 * Searches public knowledge sources:
 * 1. Indexed Mintlify docs (read from filesystem at startup)
 * 2. Slack community discussions
 * 3. Web search (handled by Claude's built-in tool)
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
import { searchSlackMessages, isSlackConfigured } from '../../slack/client.js';

let initialized = false;

/**
 * Initialize knowledge search
 * - Indexes docs from filesystem
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
        categories: categories.map(c => `${c.category}(${c.count})`).join(', '),
      },
      'Addie: Docs index ready'
    );
    initialized = true;
  } catch (error) {
    logger.warn({ error }, 'Addie: Failed to index docs');
    // Still mark as initialized - we can function with just web search
    initialized = true;
  }
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
 * We provide two search tools:
 * 1. search_docs - Search our Mintlify documentation (fast, local, authoritative for AdCP)
 * 2. search_slack - Search community discussions (real-world context)
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
    name: 'search_slack',
    description:
      'Search Slack messages from public channels in the AAO workspace. Use this to find community discussions, Q&A, and real-world examples about AdCP, agentic advertising, and related topics. Cite the Slack permalink when using information from results.',
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

  handlers.set('search_slack', async (input) => {
    if (!isSlackConfigured()) {
      return 'Slack search is not available - Slack integration is not configured.';
    }

    const query = input.query as string;
    const limit = Math.min((input.limit as number) || 5, 10);

    try {
      const results = await searchSlackMessages(query, { count: limit });

      if (results.matches.length === 0) {
        return `No Slack discussions found for: "${query}"\n\nTry search_docs for documentation or web_search for external sources.`;
      }

      const formatted = results.matches
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

      return `Found ${results.total} Slack messages (showing ${results.matches.length}):\n\n${formatted}\n\n**Remember to cite the Slack permalink when using this information.**`;
    } catch (error) {
      logger.error({ error, query }, 'Addie: Slack search failed');
      return `Slack search failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  });

  return handlers;
}
