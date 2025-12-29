/**
 * AdCP Documentation Search
 *
 * Provides search and retrieval of AdCP documentation for Addie.
 */

import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../../logger.js';
import type { AddieTool, Document, SearchResult } from '../types.js';

/**
 * In-memory document index
 */
interface DocIndex {
  documents: Map<string, Document>;
  keywords: Map<string, Set<string>>;
}

let docIndex: DocIndex | null = null;

/**
 * Initialize the document index
 */
export async function initializeDocsIndex(docsPath: string): Promise<void> {
  logger.info({ docsPath }, 'Addie: Indexing documentation');

  docIndex = {
    documents: new Map(),
    keywords: new Map(),
  };

  await indexDirectory(docsPath, docsPath);

  logger.info({ count: docIndex.documents.size }, 'Addie: Documentation indexed');
}

/**
 * Recursively index a directory
 */
async function indexDirectory(dirPath: string, basePath: string): Promise<void> {
  if (!docIndex) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);

    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') {
        continue;
      }
      await indexDirectory(fullPath, basePath);
    } else if (
      entry.isFile() &&
      (entry.name.endsWith('.md') || entry.name.endsWith('.mdx'))
    ) {
      await indexFile(fullPath, basePath);
    }
  }
}

/**
 * Index a single markdown file
 */
async function indexFile(filePath: string, basePath: string): Promise<void> {
  if (!docIndex) return;

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relativePath = path.relative(basePath, filePath);
    const title = extractTitle(content, relativePath);
    const id = relativePath.replace(/\.(md|mdx)$/, '').replace(/\//g, '-');
    const excerpt = extractExcerpt(content);

    const doc: Document = {
      id,
      title,
      path: relativePath,
      content,
      excerpt,
    };

    docIndex.documents.set(id, doc);

    // Index keywords
    const keywords = extractKeywords(content, title);
    for (const keyword of keywords) {
      if (!docIndex.keywords.has(keyword)) {
        docIndex.keywords.set(keyword, new Set());
      }
      docIndex.keywords.get(keyword)!.add(id);
    }
  } catch (error) {
    logger.warn({ filePath, error }, 'Addie: Failed to index file');
  }
}

function extractTitle(content: string, fallbackPath: string): string {
  const frontmatterMatch = content.match(/^---\n[\s\S]*?title:\s*["']?(.+?)["']?\n[\s\S]*?---/);
  if (frontmatterMatch) {
    return frontmatterMatch[1].trim();
  }

  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) {
    return headingMatch[1].trim();
  }

  return path.basename(fallbackPath, path.extname(fallbackPath));
}

function extractExcerpt(content: string): string {
  let text = content.replace(/^---\n[\s\S]*?---\n/, '');
  text = text.replace(/^#+\s+.+$/gm, '');
  text = text.replace(/```[\s\S]*?```/g, '');
  text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  text = text.replace(/!\[.*?\]\(.*?\)/g, '');

  const paragraphs = text.split(/\n\n+/).filter((p) => p.trim().length > 50);

  if (paragraphs.length > 0) {
    return paragraphs[0].trim().substring(0, 300) + '...';
  }

  return '';
}

function extractKeywords(content: string, title: string): string[] {
  const text = (title + ' ' + content).toLowerCase();

  const words = text
    .replace(/[^a-z0-9_-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .filter((w) => !STOP_WORDS.has(w));

  const adcpTerms = text.match(
    /\b(adcp|mcp|media.?buy|creative|product|campaign|publisher|advertiser|agent|tool|task|protocol)\b/gi
  );

  const keywords = new Set([...words, ...(adcpTerms || []).map((t) => t.toLowerCase())]);

  return Array.from(keywords);
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had',
  'her', 'was', 'one', 'our', 'out', 'has', 'have', 'been', 'were', 'they',
  'this', 'that', 'with', 'will', 'from', 'what', 'when', 'make', 'like',
  'just', 'over', 'such', 'into', 'than', 'then', 'them', 'these', 'some',
  'would', 'other', 'which', 'their', 'there', 'about', 'could', 'should',
]);

/**
 * Search documents by query
 */
export function searchDocs(query: string, limit: number = 5): SearchResult {
  if (!docIndex) {
    return { documents: [], query, total: 0 };
  }

  const queryKeywords = query
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);

  const scores = new Map<string, number>();

  for (const keyword of queryKeywords) {
    const exactMatches = docIndex.keywords.get(keyword);
    if (exactMatches) {
      for (const docId of exactMatches) {
        scores.set(docId, (scores.get(docId) || 0) + 2);
      }
    }

    for (const [indexedKeyword, docIds] of docIndex.keywords) {
      if (indexedKeyword.includes(keyword) || keyword.includes(indexedKeyword)) {
        for (const docId of docIds) {
          scores.set(docId, (scores.get(docId) || 0) + 1);
        }
      }
    }
  }

  const sortedDocIds = Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([docId]) => docId);

  const documents = sortedDocIds
    .map((id) => docIndex!.documents.get(id))
    .filter((doc): doc is Document => doc !== undefined);

  return {
    documents,
    query,
    total: scores.size,
  };
}

/**
 * Get a specific document
 */
export function getDoc(idOrPath: string): Document | null {
  if (!docIndex) return null;

  let doc = docIndex.documents.get(idOrPath);
  if (doc) return doc;

  for (const [, document] of docIndex.documents) {
    if (document.path === idOrPath || document.path.includes(idOrPath)) {
      return document;
    }
  }

  return null;
}

/**
 * Check if docs are indexed
 */
export function isDocsIndexed(): boolean {
  return docIndex !== null && docIndex.documents.size > 0;
}

/**
 * Tool definitions for Claude
 */
export const DOCS_TOOLS: AddieTool[] = [
  {
    name: 'search_docs',
    description:
      'Search the AdCP documentation for relevant content. Use this to answer questions about AdCP, the protocol, tools, or how things work.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The search query - use relevant keywords from the question',
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
    name: 'get_doc',
    description:
      'Get the full content of a specific documentation page. Use this after search_docs to read a document in detail.',
    input_schema: {
      type: 'object',
      properties: {
        doc_id: {
          type: 'string',
          description: 'The document ID or path from search results',
        },
      },
      required: ['doc_id'],
    },
  },
];

/**
 * Tool handlers
 */
export function createDocsToolHandlers(): Map<string, (input: Record<string, unknown>) => Promise<string>> {
  const handlers = new Map<string, (input: Record<string, unknown>) => Promise<string>>();

  handlers.set('search_docs', async (input) => {
    const query = input.query as string;
    const limit = (input.limit as number) || 5;

    const results = searchDocs(query, limit);

    if (results.documents.length === 0) {
      return `No documents found for query: "${query}"`;
    }

    const formatted = results.documents
      .map((doc, i) => `${i + 1}. **${doc.title}** (${doc.path})\n   ${doc.excerpt || 'No excerpt'}`)
      .join('\n\n');

    return `Found ${results.total} documents. Top ${results.documents.length} results:\n\n${formatted}`;
  });

  handlers.set('get_doc', async (input) => {
    const docId = input.doc_id as string;
    const doc = getDoc(docId);

    if (!doc) {
      return `Document not found: "${docId}"`;
    }

    const maxLength = 8000;
    let content = doc.content;
    if (content.length > maxLength) {
      content = content.substring(0, maxLength) + '\n\n... [truncated]';
    }

    return `# ${doc.title}\n\nPath: ${doc.path}\n\n${content}`;
  });

  return handlers;
}
