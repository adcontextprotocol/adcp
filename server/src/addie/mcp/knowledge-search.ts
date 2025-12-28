/**
 * Addie Knowledge Search
 *
 * Database-backed knowledge search for Addie using PostgreSQL full-text search.
 */

import { logger } from '../../logger.js';
import { AddieDatabase, type AddieSearchResult, type AddieKnowledge } from '../../db/addie-db.js';
import type { AddieTool } from '../types.js';

const addieDb = new AddieDatabase();
let initialized = false;

/**
 * Initialize knowledge search (just marks as ready - data is in DB)
 */
export async function initializeKnowledgeSearch(): Promise<void> {
  logger.info('Addie: Initializing knowledge search');

  // Verify we can connect and get categories
  try {
    const categories = await addieDb.getKnowledgeCategories();
    const totalDocs = categories.reduce((sum, c) => sum + c.count, 0);
    logger.info(
      { categories: categories.map(c => `${c.category}(${c.count})`).join(', '), totalDocs },
      'Addie: Knowledge search ready'
    );
    initialized = true;
  } catch (error) {
    logger.error({ error }, 'Addie: Failed to initialize knowledge search');
    throw error;
  }
}

/**
 * Check if knowledge search is ready
 */
export function isKnowledgeReady(): boolean {
  return initialized;
}

/**
 * Search knowledge documents
 */
export async function searchKnowledge(
  query: string,
  options: { category?: string; limit?: number } = {}
): Promise<{
  results: AddieSearchResult[];
  query: string;
  total: number;
}> {
  if (!initialized) {
    return { results: [], query, total: 0 };
  }

  try {
    const results = await addieDb.searchKnowledge(query, {
      category: options.category,
      limit: options.limit ?? 5,
    });

    return {
      results,
      query,
      total: results.length,
    };
  } catch (error) {
    logger.error({ error, query }, 'Addie: Knowledge search failed');
    return { results: [], query, total: 0 };
  }
}

/**
 * Get a specific knowledge document by ID
 */
export async function getKnowledgeById(id: number): Promise<AddieKnowledge | null> {
  if (!initialized) return null;

  try {
    return await addieDb.getKnowledgeById(id);
  } catch (error) {
    logger.error({ error, id }, 'Addie: Failed to get knowledge document');
    return null;
  }
}

/**
 * Get knowledge categories
 */
export async function getKnowledgeCategories(): Promise<Array<{ category: string; count: number }>> {
  if (!initialized) return [];

  try {
    return await addieDb.getKnowledgeCategories();
  } catch (error) {
    logger.error({ error }, 'Addie: Failed to get knowledge categories');
    return [];
  }
}

/**
 * Tool definitions for Claude
 */
export const KNOWLEDGE_TOOLS: AddieTool[] = [
  {
    name: 'search_knowledge',
    description:
      'Search the knowledge base for relevant information about AdCP, agentic advertising, AAO, and related topics. Use this to answer questions.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query - use relevant keywords from the question',
        },
        category: {
          type: 'string',
          description: 'Optional category filter (docs, blog, faq, perspective, guidelines)',
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
    name: 'get_knowledge',
    description:
      'Get the full content of a specific knowledge document by ID. Use this after search_knowledge to read a document in detail.',
    input_schema: {
      type: 'object',
      properties: {
        id: {
          type: 'number',
          description: 'The document ID from search results',
        },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_knowledge_categories',
    description:
      'List all knowledge categories with document counts. Use this to understand what knowledge is available.',
    input_schema: {
      type: 'object',
      properties: {},
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

  handlers.set('search_knowledge', async (input) => {
    const query = input.query as string;
    const category = input.category as string | undefined;
    const limit = (input.limit as number) || 5;

    const results = await searchKnowledge(query, { category, limit });

    if (results.results.length === 0) {
      return `No knowledge found for query: "${query}"${category ? ` in category: ${category}` : ''}`;
    }

    const formatted = results.results
      .map(
        (doc, i) =>
          `${i + 1}. **${doc.title}** [${doc.category}] (ID: ${doc.id})\n   ${doc.headline || 'No preview'}`
      )
      .join('\n\n');

    return `Found ${results.total} documents:\n\n${formatted}`;
  });

  handlers.set('get_knowledge', async (input) => {
    const id = input.id as number;
    const doc = await getKnowledgeById(id);

    if (!doc) {
      return `Knowledge document not found: ID ${id}`;
    }

    const maxLength = 8000;
    let content = doc.content;
    if (content.length > maxLength) {
      content = content.substring(0, maxLength) + '\n\n... [truncated]';
    }

    return `# ${doc.title}\n\nCategory: ${doc.category}${doc.source_url ? `\nSource: ${doc.source_url}` : ''}\n\n${content}`;
  });

  handlers.set('list_knowledge_categories', async () => {
    const categories = await getKnowledgeCategories();

    if (categories.length === 0) {
      return 'No knowledge categories found.';
    }

    const formatted = categories
      .map((c) => `- **${c.category}**: ${c.count} document${c.count === 1 ? '' : 's'}`)
      .join('\n');

    const total = categories.reduce((sum, c) => sum + c.count, 0);

    return `Knowledge base categories (${total} total documents):\n\n${formatted}`;
  });

  return handlers;
}
