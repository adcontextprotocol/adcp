/**
 * Docs Indexer for Addie
 *
 * Indexes Mintlify docs and website HTML at startup so Addie can search and reference them.
 * Content is read from the filesystem and stored in memory for fast access.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../logger.js';

// Website pages to EXCLUDE from indexing (admin, dashboard, etc.)
const WEBSITE_PAGES_TO_EXCLUDE = [
  /^admin/,           // Admin pages
  /^dashboard/,       // Dashboard pages
  /^onboarding/,      // Onboarding flow
  /^chat\.html$/,     // Chat UI itself
  /^member-profile/,  // Member profile (dynamic)
  /^org-index/,       // Organization index (dynamic)
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface IndexedDoc {
  id: string;
  title: string;
  category: string;
  path: string;
  content: string;
  sourceUrl: string;
}

// In-memory index of docs
let docsIndex: IndexedDoc[] = [];
let initialized = false;

/**
 * Extract title from markdown frontmatter or first heading
 */
function extractTitle(content: string, filename: string): string {
  // Try frontmatter title
  const frontmatterMatch = content.match(/^---\s*\n[\s\S]*?title:\s*["']?([^"'\n]+)["']?\s*\n[\s\S]*?---/);
  if (frontmatterMatch) {
    return frontmatterMatch[1].trim();
  }

  // Try first # heading
  const headingMatch = content.match(/^#\s+(.+)$/m);
  if (headingMatch) {
    return headingMatch[1].trim();
  }

  // Fall back to filename
  return filename
    .replace(/\.(md|mdx)$/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Extract category from file path
 */
function extractCategory(filePath: string, docsRoot: string): string {
  const relativePath = path.relative(docsRoot, filePath);
  const parts = relativePath.split(path.sep);

  if (parts.length > 1) {
    // Use first directory as category
    return parts[0].replace(/-/g, ' ');
  }

  return 'general';
}

/**
 * Clean markdown content - remove frontmatter, imports, JSX components
 */
function cleanContent(content: string): string {
  // Remove frontmatter
  content = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');

  // Remove import statements
  content = content.replace(/^import\s+.*$/gm, '');

  // Remove JSX components (simple cases)
  content = content.replace(/<[A-Z][a-zA-Z]*[^>]*>[\s\S]*?<\/[A-Z][a-zA-Z]*>/g, '');
  content = content.replace(/<[A-Z][a-zA-Z]*[^>]*\/>/g, '');

  // Clean up extra whitespace
  content = content.replace(/\n{3,}/g, '\n\n').trim();

  return content;
}

/**
 * Extract title from HTML <title> tag or first <h1>
 */
function extractHtmlTitle(content: string, filename: string): string {
  // Try <title> tag
  const titleMatch = content.match(/<title>([^<]+)<\/title>/i);
  if (titleMatch) {
    // Remove " - AgenticAdvertising.org" suffix if present
    return titleMatch[1].replace(/\s*[-|]\s*AgenticAdvertising\.org.*$/i, '').trim();
  }

  // Try first <h1> tag
  const h1Match = content.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  if (h1Match) {
    return h1Match[1].trim();
  }

  // Fall back to filename
  return filename
    .replace(/\.html$/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Extract text content from HTML, removing tags and scripts
 */
function extractHtmlContent(content: string): string {
  // Remove script tags and their content
  content = content.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');

  // Remove style tags and their content
  content = content.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // Remove nav and footer (navigation noise)
  content = content.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
  content = content.replace(/<div id="adcp-nav"[^>]*>[\s\S]*?<\/div>/gi, '');
  content = content.replace(/<div id="adcp-footer"[^>]*>[\s\S]*?<\/div>/gi, '');

  // Remove HTML comments
  content = content.replace(/<!--[\s\S]*?-->/g, '');

  // Replace common entities
  content = content.replace(/&nbsp;/g, ' ');
  content = content.replace(/&amp;/g, '&');
  content = content.replace(/&lt;/g, '<');
  content = content.replace(/&gt;/g, '>');
  content = content.replace(/&quot;/g, '"');
  content = content.replace(/&#39;/g, "'");
  content = content.replace(/&mdash;/g, '—');
  content = content.replace(/&ndash;/g, '–');

  // Convert list items to bullets
  content = content.replace(/<li[^>]*>/gi, '\n• ');

  // Add newlines for block elements
  content = content.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n');
  content = content.replace(/<br\s*\/?>/gi, '\n');

  // Remove all remaining HTML tags
  content = content.replace(/<[^>]+>/g, '');

  // Clean up whitespace
  content = content.replace(/\n{3,}/g, '\n\n');
  content = content.replace(/[ \t]+/g, ' ');
  content = content.trim();

  return content;
}

/**
 * Recursively find all markdown files in a directory
 */
function findMarkdownFiles(dir: string): string[] {
  const files: string[] = [];

  if (!fs.existsSync(dir)) {
    return files;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...findMarkdownFiles(fullPath));
    } else if (entry.isFile() && /\.(md|mdx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }

  return files;
}

/**
 * Build source URL from file path
 * Mintlify serves docs at /docs/ prefix (e.g., /docs/protocols/core-concepts)
 */
function buildSourceUrl(filePath: string, docsRoot: string): string {
  const relativePath = path.relative(docsRoot, filePath);
  // Remove extension and convert to URL path
  const urlPath = relativePath
    .replace(/\.(md|mdx)$/, '')
    .replace(/\/index$/, '')
    .replace(/\\/g, '/');

  return `https://docs.adcontextprotocol.org/docs/${urlPath}`;
}

/**
 * Recursively find all HTML files in a directory
 */
function findHtmlFiles(dir: string, relativeTo: string = dir): string[] {
  const files: string[] = [];

  if (!fs.existsSync(dir)) {
    return files;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...findHtmlFiles(fullPath, relativeTo));
    } else if (entry.isFile() && entry.name.endsWith('.html')) {
      // Get path relative to public root
      const relativePath = path.relative(relativeTo, fullPath).replace(/\\/g, '/');
      files.push(relativePath);
    }
  }

  return files;
}

/**
 * Check if a page should be excluded from indexing
 */
function shouldExcludePage(relativePath: string): boolean {
  return WEBSITE_PAGES_TO_EXCLUDE.some((pattern) => pattern.test(relativePath));
}

/**
 * Index website HTML pages (membership, about, etc.)
 * Automatically discovers all HTML files, excluding admin/dashboard pages
 */
function indexWebsitePages(publicRoot: string): IndexedDoc[] {
  const indexed: IndexedDoc[] = [];

  // Find all HTML files in public directory
  const htmlFiles = findHtmlFiles(publicRoot);

  for (const relativePath of htmlFiles) {
    // Skip excluded pages (admin, dashboard, etc.)
    if (shouldExcludePage(relativePath)) {
      continue;
    }

    const filePath = path.join(publicRoot, relativePath);

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const title = extractHtmlTitle(content, path.basename(relativePath));
      const cleanedContent = extractHtmlContent(content);

      // Skip empty or very short files
      if (cleanedContent.length < 100) {
        continue;
      }

      // Build ID and URL path
      const idPath = relativePath.replace(/\.html$/, '').replace(/\/index$/, '');
      const id = `website:${idPath || 'home'}`;

      // URL path: index.html -> /, foo/index.html -> /foo, foo.html -> /foo
      let urlPath = relativePath.replace(/\.html$/, '').replace(/\/index$/, '');
      if (relativePath === 'index.html') {
        urlPath = '';
      }

      indexed.push({
        id,
        title,
        category: 'website',
        path: relativePath,
        content: cleanedContent,
        sourceUrl: `https://agenticadvertising.org/${urlPath}`,
      });
    } catch (error) {
      logger.warn({ error, filePath }, 'Addie Docs: Failed to index website page');
    }
  }

  return indexed;
}

/**
 * Initialize the docs indexer
 */
export async function initializeDocsIndex(): Promise<void> {
  // Find docs directory - try multiple locations
  const possibleDocsPaths = [
    // From server/src/addie/mcp/ to docs/
    path.resolve(__dirname, '../../../../docs'),
    // From dist/ to docs/
    path.resolve(__dirname, '../../../docs'),
    // Absolute path for Docker (mounted volume)
    '/app/docs',
  ];

  // Find public directory for website pages
  const possiblePublicPaths = [
    // From server/src/addie/mcp/ to server/public/
    path.resolve(__dirname, '../../../public'),
    // From dist/ to server/public/
    path.resolve(__dirname, '../../public'),
    // Absolute path for Docker
    '/app/server/public',
  ];

  let docsRoot: string | null = null;
  for (const p of possibleDocsPaths) {
    if (fs.existsSync(p)) {
      docsRoot = p;
      break;
    }
  }

  let publicRoot: string | null = null;
  for (const p of possiblePublicPaths) {
    if (fs.existsSync(p)) {
      publicRoot = p;
      break;
    }
  }

  docsIndex = [];

  // Index markdown docs
  if (docsRoot) {
    logger.info({ docsRoot }, 'Addie Docs: Indexing documentation');

    const markdownFiles = findMarkdownFiles(docsRoot);

    for (const filePath of markdownFiles) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const filename = path.basename(filePath);
        const title = extractTitle(content, filename);
        const category = extractCategory(filePath, docsRoot);
        const cleanedContent = cleanContent(content);

        // Skip empty or very short files
        if (cleanedContent.length < 100) {
          continue;
        }

        // Create a unique ID from the path
        const relativePath = path.relative(docsRoot, filePath);
        const id = `doc:${relativePath.replace(/\\/g, '/').replace(/\.(md|mdx)$/, '')}`;

        docsIndex.push({
          id,
          title,
          category,
          path: relativePath,
          content: cleanedContent,
          sourceUrl: buildSourceUrl(filePath, docsRoot),
        });
      } catch (error) {
        logger.warn({ error, filePath }, 'Addie Docs: Failed to index file');
      }
    }
  } else {
    logger.warn({ paths: possibleDocsPaths }, 'Addie Docs: Could not find docs directory');
  }

  // Index website HTML pages
  if (publicRoot) {
    logger.info({ publicRoot }, 'Addie Docs: Indexing website pages');
    const websitePages = indexWebsitePages(publicRoot);
    docsIndex.push(...websitePages);
  } else {
    logger.warn({ paths: possiblePublicPaths }, 'Addie Docs: Could not find public directory');
  }

  initialized = true;

  const categories = [...new Set(docsIndex.map((d) => d.category))];
  const websiteCount = docsIndex.filter((d) => d.category === 'website').length;

  logger.info(
    {
      totalDocs: docsIndex.length,
      websitePages: websiteCount,
      categories: categories.join(', '),
    },
    'Addie Docs: Indexing complete'
  );
}

/**
 * Check if docs index is ready
 */
export function isDocsIndexReady(): boolean {
  return initialized;
}

/**
 * Search indexed docs using simple keyword matching
 */
export function searchDocs(
  query: string,
  options: { category?: string; limit?: number } = {}
): IndexedDoc[] {
  if (!initialized || docsIndex.length === 0) {
    return [];
  }

  const limit = options.limit ?? 5;
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2);

  // Score each document
  const scored = docsIndex
    .filter((doc) => {
      // Filter by category if specified
      if (options.category && doc.category.toLowerCase() !== options.category.toLowerCase()) {
        return false;
      }
      return true;
    })
    .map((doc) => {
      const titleLower = doc.title.toLowerCase();
      const contentLower = doc.content.toLowerCase();

      let score = 0;

      // Exact query match in title (highest weight)
      if (titleLower.includes(queryLower)) {
        score += 100;
      }

      // Exact query match in content
      if (contentLower.includes(queryLower)) {
        score += 50;
      }

      // Individual word matches
      for (const word of queryWords) {
        if (titleLower.includes(word)) {
          score += 20;
        }
        // Count occurrences in content (limited to avoid huge scores)
        const occurrences = Math.min((contentLower.match(new RegExp(word, 'g')) || []).length, 10);
        score += occurrences * 2;
      }

      return { doc, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ doc }) => doc);

  return scored;
}

/**
 * Get a doc by ID
 */
export function getDocById(id: string): IndexedDoc | null {
  return docsIndex.find((doc) => doc.id === id) || null;
}

/**
 * Get all doc categories with counts
 */
export function getDocCategories(): Array<{ category: string; count: number }> {
  const counts = new Map<string, number>();

  for (const doc of docsIndex) {
    counts.set(doc.category, (counts.get(doc.category) || 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Get total doc count
 */
export function getDocCount(): number {
  return docsIndex.length;
}
