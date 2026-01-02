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

/**
 * Indexed heading - a section within a doc, searchable by itself
 * Enables deep linking directly to specific sections
 */
export interface IndexedHeading {
  id: string;              // e.g., "doc:media-buy/targeting#geographic-targeting"
  doc_id: string;          // parent doc ID
  anchor: string;          // e.g., "geographic-targeting"
  title: string;           // heading text
  level: number;           // 2, 3 (we skip level 1 - that's the doc title)
  parent_headings: string[]; // breadcrumb path: ["Targeting", "Geographic Targeting"]
  content: string;         // content under this heading until next same-level heading
  sourceUrl: string;       // with anchor: ".../targeting#geographic-targeting"
}

// In-memory indices
let docsIndex: IndexedDoc[] = [];
let headingsIndex: IndexedHeading[] = [];
let initialized = false;

/**
 * Generate a URL-safe anchor slug from heading text
 * Follows Mintlify/GitHub conventions for heading anchors
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '') // Remove special chars
    .replace(/\s+/g, '-')          // Spaces to hyphens
    .replace(/-+/g, '-')           // Collapse multiple hyphens
    .replace(/^-|-$/g, '');        // Trim leading/trailing hyphens
}

/**
 * Extract headings from markdown content with their content sections
 */
function extractHeadings(
  content: string,
  docId: string,
  docTitle: string,
  baseUrl: string
): IndexedHeading[] {
  const headings: IndexedHeading[] = [];
  const lines = content.split('\n');

  // Track the parent heading stack for breadcrumbs
  const parentStack: Array<{ level: number; title: string }> = [];

  let currentHeading: {
    level: number;
    title: string;
    anchor: string;
    startLine: number;
    parentHeadings: string[];
  } | null = null;

  let contentLines: string[] = [];
  let inCodeBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track code blocks to avoid extracting headings from code examples
    if (line.startsWith('```')) {
      inCodeBlock = !inCodeBlock;
      if (currentHeading) contentLines.push(line);
      continue;
    }

    // Skip processing inside code blocks
    if (inCodeBlock) {
      if (currentHeading) contentLines.push(line);
      continue;
    }

    // Match ## or ### headings (skip # which is the doc title)
    const headingMatch = line.match(/^(#{2,3})\s+(.+)$/);

    if (headingMatch) {
      // Save previous heading if exists
      if (currentHeading) {
        const headingContent = contentLines.join('\n').trim();
        if (headingContent.length > 20) { // Only index headings with meaningful content
          headings.push({
            id: `${docId}#${currentHeading.anchor}`,
            doc_id: docId,
            anchor: currentHeading.anchor,
            title: currentHeading.title,
            level: currentHeading.level,
            parent_headings: currentHeading.parentHeadings,
            content: headingContent,
            sourceUrl: `${baseUrl}#${currentHeading.anchor}`,
          });
        }
      }

      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();
      const anchor = slugify(title);

      // Update parent stack - pop any headings at same or lower level
      while (parentStack.length > 0 && parentStack[parentStack.length - 1].level >= level) {
        parentStack.pop();
      }

      // Build breadcrumb from stack + current
      const parentHeadings = [docTitle, ...parentStack.map(p => p.title)];

      // Push current heading onto stack
      parentStack.push({ level, title });

      currentHeading = {
        level,
        title,
        anchor,
        startLine: i,
        parentHeadings,
      };

      contentLines = [];
    } else if (currentHeading) {
      contentLines.push(line);
    }
  }

  // Don't forget the last heading
  if (currentHeading) {
    const headingContent = contentLines.join('\n').trim();
    if (headingContent.length > 20) {
      headings.push({
        id: `${docId}#${currentHeading.anchor}`,
        doc_id: docId,
        anchor: currentHeading.anchor,
        title: currentHeading.title,
        level: currentHeading.level,
        parent_headings: currentHeading.parentHeadings,
        content: headingContent,
        sourceUrl: `${baseUrl}#${currentHeading.anchor}`,
      });
    }
  }

  return headings;
}

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
  headingsIndex = [];

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
        const sourceUrl = buildSourceUrl(filePath, docsRoot);

        docsIndex.push({
          id,
          title,
          category,
          path: relativePath,
          content: cleanedContent,
          sourceUrl,
        });

        // Extract and index headings from this doc
        const docHeadings = extractHeadings(cleanedContent, id, title, sourceUrl);
        headingsIndex.push(...docHeadings);
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
      totalHeadings: headingsIndex.length,
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

/**
 * Get total heading count
 */
export function getHeadingCount(): number {
  return headingsIndex.length;
}

/**
 * Search indexed headings
 * Returns headings that match the query, with scores
 */
export function searchHeadings(
  query: string,
  options: { docId?: string; limit?: number } = {}
): IndexedHeading[] {
  if (!initialized || headingsIndex.length === 0) {
    return [];
  }

  const limit = options.limit ?? 5;
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2);

  // Score each heading
  const scored = headingsIndex
    .filter((heading) => {
      // Filter by doc if specified
      if (options.docId && heading.doc_id !== options.docId) {
        return false;
      }
      return true;
    })
    .map((heading) => {
      const titleLower = heading.title.toLowerCase();
      const contentLower = heading.content.toLowerCase();

      let score = 0;

      // Exact query match in title (highest weight)
      if (titleLower.includes(queryLower)) {
        score += 150;
      }

      // Exact title match (bonus)
      if (titleLower === queryLower) {
        score += 100;
      }

      // Exact query match in content
      if (contentLower.includes(queryLower)) {
        score += 30;
      }

      // Individual word matches
      for (const word of queryWords) {
        if (titleLower.includes(word)) {
          score += 25;
        }
        // Count occurrences in content (limited to avoid huge scores)
        const occurrences = Math.min((contentLower.match(new RegExp(word, 'g')) || []).length, 5);
        score += occurrences * 2;
      }

      return { heading, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ heading }) => heading);

  return scored;
}

/**
 * Get a heading by ID (doc_id#anchor format)
 */
export function getHeadingById(id: string): IndexedHeading | null {
  return headingsIndex.find((h) => h.id === id) || null;
}
