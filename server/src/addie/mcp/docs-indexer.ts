/**
 * Docs Indexer for Addie
 *
 * Indexes Mintlify docs, JSON schemas, and website HTML at startup so Addie can search and reference them.
 * Content is read from the filesystem and stored in memory for fast access.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'node:crypto';
import { createLogger } from '../../logger.js';

const logger = createLogger('addie-docs-indexer');
import { WorkingGroupDatabase } from '../../db/working-group-db.js';

// Website pages to EXCLUDE from indexing (admin, dashboard, etc.)
const WEBSITE_PAGES_TO_EXCLUDE = [
  /^admin/,           // Admin pages
  /^dashboard/,       // Dashboard pages
  /^onboarding/,      // Onboarding flow
  /^chat\.html$/,     // Chat UI itself
  /^member-profile/,  // Member profile (dynamic)
  /^org-index/,       // Organization index (dynamic)
];

// Aggregate schemas duplicate large portions of the component schemas and
// overwhelm keyword ranking. Their referenced component schemas are indexed.
const SCHEMA_FILES_TO_EXCLUDE = new Set([
  'index.json',
  'protocol/get-adcp-capabilities-response.json',
  'brand.json',
]);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface IndexedDoc {
  id: string;
  title: string;
  category: string;
  path: string;
  content: string;
  sourceUrl: string;
  /** Protocol version this content describes. Undefined means version-independent. */
  version?: string;
  /** Frozen release directory backing this result (for example, 3.1.19). */
  artifactVersion?: string;
}

export interface DocsVersion {
  /** Public version selector used by Mintlify and Addie's tools. */
  version: string;
  /** Exact frozen dist/docs and dist/schemas snapshot. */
  artifactVersion: string;
  displayName: string;
  isDefault: boolean;
  isArchived: boolean;
  /** Logical doc paths present in this version's public navigation. */
  pagePaths: Set<string>;
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
let docsVersions: DocsVersion[] = [];
let errorCodesByDocsVersion = new Map<string, Set<string> | null>();
let allKnownErrorCodes = new Set<string>();
let docsCorpusFingerprint: string | null = null;

function computeDocsCorpusFingerprint(): string {
  const hash = createHash('sha256');
  for (const doc of [...docsIndex].sort((left, right) => left.id.localeCompare(right.id))) {
    hash.update(JSON.stringify([
      doc.id,
      doc.title,
      doc.category,
      doc.path,
      doc.content,
      doc.sourceUrl,
      doc.version ?? null,
      doc.artifactVersion ?? null,
    ]));
    hash.update('\n');
  }
  return hash.digest('hex');
}

// These describe the organization and community rather than a protocol release.
// Keep their live copies searchable alongside every protocol version.
const VERSION_INDEPENDENT_DOC_PREFIXES = ['aao/', 'community/', 'contributing/'];

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
export function cleanContent(content: string): string {
  // Remove frontmatter
  content = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');

  // Remove import statements
  content = content.replace(/^import\s+.*$/gm, '');

  // Remove JSX component tags while preserving their searchable children.
  content = content.replace(/<\/?[A-Z][a-zA-Z]*[^>]*>/g, '');

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
  // Remove script and style tags with their content (loop to handle nested cases)
  let prev = '';
  let iterations = 0;
  while (prev !== content && iterations++ < 100) {
    prev = content;
    content = content
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  }

  // Remove nav and footer (navigation noise)
  content = content.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
  content = content.replace(/<div id="adcp-nav"[^>]*>[\s\S]*?<\/div>/gi, '');
  content = content.replace(/<div id="adcp-footer"[^>]*>[\s\S]*?<\/div>/gi, '');

  // Remove HTML comments (loop to handle nested/malformed comments)
  let commentPrev = '';
  let commentIterations = 0;
  while (commentPrev !== content && commentIterations++ < 100) {
    commentPrev = content;
    content = content.replace(/<!--[\s\S]*?-->/g, '');
  }

  // Single-pass entity decode to prevent multi-character sanitization interaction
  const ENTITY_MAP: Record<string, string> = {
    '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&quot;': '"',
    '&#39;': "'", '&mdash;': '—', '&ndash;': '–', '&amp;': '&',
  };
  content = content.replace(
    /&(?:nbsp|lt|gt|quot|mdash|ndash|amp|#39);/g,
    (match) => ENTITY_MAP[match] || match
  );

  // Convert list items to bullets
  content = content.replace(/<li[^>]*>/gi, '\n• ');

  // Add newlines for block elements
  content = content.replace(/<\/(p|div|h[1-6]|li|tr)>/gi, '\n');
  content = content.replace(/<br\s*\/?>/gi, '\n');

  // Remove all remaining HTML tags (loop to catch tags reconstructed by entity decode)
  let tagPrev = '';
  let tagIterations = 0;
  while (tagPrev !== content && tagIterations++ < 100) {
    tagPrev = content;
    content = content.replace(/<[^>]+>/g, '');
  }

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

/** Recursively find JSON schema files. */
function findJsonFiles(dir: string): string[] {
  const files: string[] = [];

  if (!fs.existsSync(dir)) {
    return files;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findJsonFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      files.push(fullPath);
    }
  }

  return files;
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item) => ['string', 'number', 'boolean'].includes(typeof item) || item === null)
    .map((item) => JSON.stringify(item));
}

/**
 * Extract the human-meaningful/searchable portion of a JSON schema.
 * Structural validation keywords are deliberately omitted unless they name
 * fields, references, required fields, or allowed values.
 */
export function extractSchemaContent(schema: unknown): string {
  if (!isJsonObject(schema)) return '';

  const lines = new Set<string>();
  const rootId = typeof schema.$id === 'string' ? schema.$id : null;
  if (rootId) lines.add(`Schema ID: ${rootId}`);
  if (typeof schema.description === 'string') lines.add(schema.description.trim());

  const visit = (node: unknown, fieldPath: string): void => {
    if (!isJsonObject(node)) return;

    const label = fieldPath || 'Schema';
    if (typeof node.description === 'string') {
      lines.add(`${label}: ${node.description.trim()}`);
    }
    if (typeof node.$ref === 'string') {
      lines.add(`${label} references ${node.$ref}`);
    }

    const enumValues = stringValues(node.enum);
    if (enumValues.length > 0) {
      lines.add(`${label} allowed values: ${enumValues.join(', ')}`);
    }
    if (['string', 'number', 'boolean'].includes(typeof node.const) || node.const === null) {
      lines.add(`${label} fixed value: ${JSON.stringify(node.const)}`);
    }

    const required = stringValues(node.required);
    if (required.length > 0) {
      lines.add(`${label} required fields: ${required.join(', ')}`);
    }

    if (isJsonObject(node.properties)) {
      for (const [propertyName, propertySchema] of Object.entries(node.properties)) {
        const propertyPath = fieldPath ? `${fieldPath}.${propertyName}` : propertyName;
        lines.add(`Field: ${propertyPath}`);
        visit(propertySchema, propertyPath);
      }
    }

    if (node.items) visit(node.items, fieldPath ? `${fieldPath}[]` : 'items[]');

    for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
      const alternatives = node[keyword];
      if (Array.isArray(alternatives)) {
        for (const alternative of alternatives) visit(alternative, fieldPath);
      }
    }

    for (const keyword of ['$defs', 'definitions'] as const) {
      const definitions = node[keyword];
      if (!isJsonObject(definitions)) continue;
      for (const [definitionName, definitionSchema] of Object.entries(definitions)) {
        visit(definitionSchema, fieldPath || definitionName);
      }
    }
  };

  visit(schema, '');
  return [...lines].filter(Boolean).join('\n');
}

function schemaTitle(schema: JsonObject, relativePath: string): string {
  if (typeof schema.title === 'string' && schema.title.trim()) return schema.title.trim();

  const id = typeof schema.$id === 'string' ? schema.$id : relativePath;
  return path.basename(id)
    .replace(/\.json$/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function indexSchemaFiles(
  schemaRoot: string,
  version: string,
  artifactVersion: string,
  unavailableErrorCodePattern: RegExp | null,
): IndexedDoc[] {
  const indexed: IndexedDoc[] = [];

  for (const filePath of findJsonFiles(schemaRoot)) {
    const relativePath = path.relative(schemaRoot, filePath).replace(/\\/g, '/');
    if (SCHEMA_FILES_TO_EXCLUDE.has(relativePath)) continue;

    try {
      const schema = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
      if (!isJsonObject(schema)) continue;

      const content = removeUnavailableErrorCodeLines(
        extractSchemaContent(schema),
        unavailableErrorCodePattern,
      );
      if (!content) continue;

      indexed.push({
        id: `schema:${version}:${relativePath.replace(/\.json$/, '')}`,
        title: schemaTitle(schema, relativePath),
        category: 'schema',
        path: relativePath,
        content,
        sourceUrl: `https://adcontextprotocol.org/schemas/${artifactVersion}/${relativePath}`,
        version,
        artifactVersion,
      });
    } catch (error) {
      logger.warn({ error, filePath }, 'Addie Docs: Failed to index schema');
    }
  }

  return indexed;
}

/**
 * Build a source URL for live, version-independent operational docs.
 * Mintlify's clean /docs routes redirect to the stable frozen snapshot, which
 * may not contain the live body Addie indexed. Link to the canonical source so
 * citations always open the exact content returned by search.
 */
function buildSourceUrl(filePath: string, docsRoot: string): string {
  const urlPath = path.relative(docsRoot, filePath).replace(/\\/g, '/');

  return `https://github.com/adcontextprotocol/adcp/blob/main/docs/${urlPath}`;
}

function buildVersionedSourceUrl(relativePath: string, artifactVersion: string): string {
  const urlPath = relativePath
    .replace(/\.(md|mdx)$/, '')
    .replace(/\/index$/, '')
    .replace(/\\/g, '/');

  return `https://docs.adcontextprotocol.org/dist/docs/${artifactVersion}/${urlPath}`;
}

function findFirstExistingPath(candidates: string[]): string | null {
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function collectNavigationPagePaths(value: unknown, artifactVersions: Set<string>): Set<string> {
  const paths = new Set<string>();

  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      const match = node.match(/^dist\/docs\/([^/]+)\/(.+)$/);
      if (match && artifactVersions.has(match[1])) {
        paths.add(match[2].replace(/\.(md|mdx)$/, ''));
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (node && typeof node === 'object') {
      Object.values(node as Record<string, unknown>).forEach(visit);
    }
  };

  visit(value);
  return paths;
}

function loadDocsVersions(configPath: string): DocsVersion[] {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as {
    navigation?: { versions?: Array<Record<string, unknown>> };
  };
  const navigationVersions = config.navigation?.versions;
  if (!Array.isArray(navigationVersions) || navigationVersions.length === 0) {
    throw new Error(`No navigation.versions found in ${configPath}`);
  }

  const versions = navigationVersions.map((entry): DocsVersion => {
    const displayName = String(entry.version || '').trim();
    const artifactVersions = new Set<string>();

    const findArtifacts = (node: unknown): void => {
      if (typeof node === 'string') {
        const match = node.match(/^dist\/docs\/([^/]+)\//);
        if (match) artifactVersions.add(match[1]);
      } else if (Array.isArray(node)) {
        node.forEach(findArtifacts);
      } else if (node && typeof node === 'object') {
        Object.values(node as Record<string, unknown>).forEach(findArtifacts);
      }
    };
    findArtifacts(entry.groups);

    if (!displayName || artifactVersions.size !== 1) {
      throw new Error(
        `Docs version ${displayName || '<unnamed>'} must reference exactly one dist/docs snapshot; found ${[...artifactVersions].join(', ') || 'none'}`,
      );
    }

    const artifactVersion = [...artifactVersions][0];
    return {
      version: displayName.replace(/\s*\(archived\)\s*$/i, ''),
      artifactVersion,
      displayName,
      isDefault: entry.default === true,
      isArchived: /\(archived\)/i.test(displayName),
      pagePaths: collectNavigationPagePaths(entry.groups, artifactVersions),
    };
  });

  if (versions.filter((version) => version.isDefault).length !== 1) {
    throw new Error('docs.json must declare exactly one default documentation version');
  }

  return versions;
}

export function versionAliases(version: DocsVersion, versions = docsVersions): string[] {
  const aliases = [version.version, version.displayName, version.artifactVersion];
  if (version.isDefault) aliases.push('latest', 'stable', 'current', 'v3');
  const prereleaseMatch = version.version.match(/^(\d+\.\d+)-(beta|rc)$/);
  if (prereleaseMatch) {
    const [, releaseLine, channel] = prereleaseMatch;
    aliases.push(`${releaseLine} ${channel}`);
    const currentPreview = versions.find(
      (candidate) => candidate.version.match(/^(\d+\.\d+)-(?:beta|rc)$/)?.[1] === releaseLine,
    );
    if (currentPreview === version) aliases.push(releaseLine);
  }
  return aliases.map((alias) => alias.toLowerCase());
}

/** Resolve a public selector to one frozen docs version. Defaults to stable. */
export function resolveDocsVersion(requested?: string): DocsVersion | null {
  if (docsVersions.length === 0) return null;
  if (!requested) return docsVersions.find((version) => version.isDefault) || null;

  const normalized = requested.trim().toLowerCase();
  return docsVersions.find((version) => versionAliases(version).includes(normalized)) || null;
}

export function getSupportedDocsVersions(): DocsVersion[] {
  return docsVersions.map((version) => ({ ...version, pagePaths: new Set(version.pagePaths) }));
}

export function formatDocsVersion(version: Pick<DocsVersion, 'displayName' | 'artifactVersion'>): string {
  return `${version.displayName} (snapshot ${version.artifactVersion})`;
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

function readVersionErrorCodes(schemaRoot: string): Set<string> | null {
  const errorCodePath = path.join(schemaRoot, 'enums', 'error-code.json');
  if (!fs.existsSync(errorCodePath)) return null;

  try {
    const schema = JSON.parse(fs.readFileSync(errorCodePath, 'utf-8')) as { enum?: unknown[] };
    return new Set((schema.enum || []).filter((value): value is string => typeof value === 'string'));
  } catch (error) {
    logger.warn({ error, errorCodePath }, 'Addie Docs: Failed to read version error-code enum');
    return null;
  }
}

/**
 * Frozen prose snapshots predate the immutable-release guard and a few contain
 * error-code rows copied from a newer branch. The closed enum is authoritative;
 * remove lines naming codes unavailable in the selected release before search.
 */
function buildUnavailableErrorCodePattern(
  allowedCodes: Set<string> | null,
  allKnownCodes: Set<string>,
): RegExp | null {
  if (!allowedCodes) return null;
  const unavailableCodes = [...allKnownCodes].filter((code) => !allowedCodes.has(code));
  return unavailableCodes.length > 0
    ? new RegExp(`\\b(?:${unavailableCodes.join('|')})\\b`)
    : null;
}

function removeUnavailableErrorCodeLines(
  content: string,
  unavailablePattern: RegExp | null,
): string {
  if (!unavailablePattern) return content;
  return content
    .split('\n')
    .filter((line) => !unavailablePattern.test(line))
    .join('\n');
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
  const docsRoot = findFirstExistingPath([
    path.resolve(__dirname, '../../../../docs'),
    path.resolve(__dirname, '../../../docs'),
    '/app/docs',
  ]);

  const docsConfigPath = findFirstExistingPath([
    path.resolve(__dirname, '../../../../docs.json'),
    path.resolve(__dirname, '../../../docs.json'),
    '/app/docs.json',
  ]);

  const versionedDocsRoot = findFirstExistingPath([
    path.resolve(__dirname, '../../../../dist/docs'),
    path.resolve(__dirname, '../../docs'),
    path.resolve(__dirname, '../../../dist/docs'),
    '/app/dist/docs',
  ]);

  const versionedSchemasRoot = findFirstExistingPath([
    path.resolve(__dirname, '../../../../dist/schemas'),
    path.resolve(__dirname, '../../schemas'),
    path.resolve(__dirname, '../../../dist/schemas'),
    '/app/dist/schemas',
  ]);

  if (!docsConfigPath || !versionedDocsRoot || !versionedSchemasRoot) {
    throw new Error(
      'Versioned documentation is required: docs.json, dist/docs, and dist/schemas must be available',
    );
  }

  docsVersions = loadDocsVersions(docsConfigPath);

  // Find public directory for website pages
  const possiblePublicPaths = [
    // From server/src/addie/mcp/ to server/public/
    path.resolve(__dirname, '../../../public'),
    // From dist/ to server/public/
    path.resolve(__dirname, '../../public'),
    // Absolute path for Docker
    '/app/server/public',
  ];

  let publicRoot: string | null = null;
  for (const p of possiblePublicPaths) {
    if (fs.existsSync(p)) {
      publicRoot = p;
      break;
    }
  }

  const nextDocsIndex: IndexedDoc[] = [];
  const nextHeadingsIndex: IndexedHeading[] = [];

  errorCodesByDocsVersion = new Map<string, Set<string> | null>();
  allKnownErrorCodes = new Set<string>();
  for (const version of docsVersions) {
    const schemaRoot = path.join(versionedSchemasRoot, version.artifactVersion);
    const codes = readVersionErrorCodes(schemaRoot);
    errorCodesByDocsVersion.set(version.version, codes);
    codes?.forEach((code) => allKnownErrorCodes.add(code));
  }

  // Index only explicitly version-independent live docs. Protocol content
  // comes from the frozen snapshots selected by docs.json below.
  if (docsRoot) {
    logger.info({ docsRoot }, 'Addie Docs: Indexing version-independent documentation');

    const markdownFiles = findMarkdownFiles(docsRoot).filter((filePath) => {
      const relativePath = path.relative(docsRoot, filePath).replace(/\\/g, '/');
      return VERSION_INDEPENDENT_DOC_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
    });

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

        nextDocsIndex.push({
          id,
          title,
          category,
          path: relativePath,
          content: cleanedContent,
          sourceUrl,
        });

        // Extract and index headings from this doc
        const docHeadings = extractHeadings(cleanedContent, id, title, sourceUrl);
        nextHeadingsIndex.push(...docHeadings);
      } catch (error) {
        logger.warn({ error, filePath }, 'Addie Docs: Failed to index file');
      }
    }
  } else {
    logger.warn('Addie Docs: Could not find live docs directory; version-independent docs unavailable');
  }

  // Index the exact frozen docs and schemas exposed in Mintlify navigation.
  for (const version of docsVersions) {
    const versionDocsRoot = path.join(versionedDocsRoot, version.artifactVersion);
    const versionSchemaRoot = path.join(versionedSchemasRoot, version.artifactVersion);
    if (!fs.existsSync(versionDocsRoot) || !fs.existsSync(versionSchemaRoot)) {
      throw new Error(
        `Missing Addie search snapshot for ${version.displayName}: ${version.artifactVersion}`,
      );
    }

    logger.info(
      { version: version.version, artifactVersion: version.artifactVersion },
      'Addie Docs: Indexing frozen protocol documentation',
    );

    const allowedCodes = errorCodesByDocsVersion.get(version.version) || null;
    const unavailableErrorCodePattern = buildUnavailableErrorCodePattern(
      allowedCodes,
      allKnownErrorCodes,
    );
    for (const filePath of findMarkdownFiles(versionDocsRoot)) {
      const relativePath = path.relative(versionDocsRoot, filePath).replace(/\\/g, '/');
      const logicalPath = relativePath.replace(/\.(md|mdx)$/, '');
      if (!version.pagePaths.has(logicalPath)) continue;
      if (VERSION_INDEPENDENT_DOC_PREFIXES.some((prefix) => relativePath.startsWith(prefix))) continue;

      try {
        const rawContent = fs.readFileSync(filePath, 'utf-8');
        const cleanedContent = removeUnavailableErrorCodeLines(
          cleanContent(rawContent),
          unavailableErrorCodePattern,
        );
        if (cleanedContent.length < 100) continue;

        const title = extractTitle(rawContent, path.basename(filePath));
        const id = `doc:${version.version}:${logicalPath}`;
        const sourceUrl = buildVersionedSourceUrl(relativePath, version.artifactVersion);
        nextDocsIndex.push({
          id,
          title,
          category: extractCategory(filePath, versionDocsRoot),
          path: relativePath,
          content: cleanedContent,
          sourceUrl,
          version: version.version,
          artifactVersion: version.artifactVersion,
        });
        nextHeadingsIndex.push(...extractHeadings(cleanedContent, id, title, sourceUrl));
      } catch (error) {
        logger.warn({ error, filePath }, 'Addie Docs: Failed to index versioned file');
      }
    }

    nextDocsIndex.push(...indexSchemaFiles(
      versionSchemaRoot,
      version.version,
      version.artifactVersion,
      unavailableErrorCodePattern,
    ));
  }

  // Index website HTML pages
  if (publicRoot) {
    logger.info({ publicRoot }, 'Addie Docs: Indexing website pages');
    const websitePages = indexWebsitePages(publicRoot);
    nextDocsIndex.push(...websitePages);
  } else {
    logger.warn({ paths: possiblePublicPaths }, 'Addie Docs: Could not find public directory');
  }

  // Index working group documents from database
  try {
    const workingGroupDocs = await loadWorkingGroupDocuments();
    nextDocsIndex.push(...workingGroupDocs);
    if (workingGroupDocs.length > 0) {
      logger.info({ count: workingGroupDocs.length }, 'Addie Docs: Indexed working group documents');
    }
  } catch (error) {
    logger.warn({ error }, 'Addie Docs: Failed to index working group documents');
  }

  // Index published perspectives from database
  try {
    const perspectives = await loadPublishedPerspectives();
    nextDocsIndex.push(...perspectives);
    if (perspectives.length > 0) {
      logger.info({ count: perspectives.length }, 'Addie Docs: Indexed published perspectives');
    }
  } catch (error) {
    logger.warn({ error }, 'Addie Docs: Failed to index perspectives');
  }

  docsIndex = nextDocsIndex;
  headingsIndex = nextHeadingsIndex;
  docsCorpusFingerprint = computeDocsCorpusFingerprint();
  initialized = true;

  const categories = [...new Set(docsIndex.map((d) => d.category))];
  const websiteCount = docsIndex.filter((d) => d.category === 'website').length;
  const workingGroupCount = docsIndex.filter((d) => d.category.startsWith('working group')).length;
  const perspectiveCount = docsIndex.filter((d) => d.category === 'perspective').length;
  const schemaCount = docsIndex.filter((d) => d.category === 'schema').length;
  const protocolDocCount = docsIndex.length - websiteCount - workingGroupCount - perspectiveCount - schemaCount;

  // Warn if protocol docs index seems suspiciously empty (expect 50+ docs)
  if (protocolDocCount < 10) {
    logger.error(
      { protocolDocCount, docsRoot },
      'Addie Docs: Protocol doc count is suspiciously low — search_docs may return incomplete results'
    );
  }

  logger.info(
    {
      totalDocs: docsIndex.length,
      totalHeadings: headingsIndex.length,
      protocolDocs: protocolDocCount,
      schemas: schemaCount,
      websitePages: websiteCount,
      workingGroupDocs: workingGroupCount,
      perspectives: perspectiveCount,
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
 * Stable digest of the exact in-memory corpus used by search_docs/get_doc.
 * Replay captures bind to this value so a refresh cannot be mislabeled as
 * the same evidence source. The corpus itself never leaves this module.
 */
export function getDocsCorpusFingerprint(): string | null {
  return initialized ? docsCorpusFingerprint : null;
}

/**
 * Search indexed docs using simple keyword matching
 */
export function searchDocs(
  query: string,
  options: { category?: string; limit?: number; version?: string } = {}
): IndexedDoc[] {
  if (!initialized || docsIndex.length === 0) {
    return [];
  }

  const limit = options.limit ?? 5;
  const selectedVersion = resolveDocsVersion(options.version);
  if (!selectedVersion) return [];
  const queryLower = query.toLowerCase();
  const allowedErrorCodes = errorCodesByDocsVersion.get(selectedVersion.version);
  if (allowedErrorCodes) {
    // Only a literal enum token (for example, `ACCOUNT_REQUIRED`) proves the
    // caller is asking about that error code. Natural-language wording such
    // as "is an account required?" must remain searchable.
    const queryTokens = new Set(queryLower.match(/[a-z0-9_]+/g) || []);
    const unavailableCodeRequested = [...allKnownErrorCodes].some((code) => {
      if (allowedErrorCodes.has(code)) return false;
      return queryTokens.has(code.toLowerCase());
    });
    if (unavailableCodeRequested) return [];
  }
  const queryWords = [...new Set(
    queryLower
      .split(/[^a-z0-9_-]+/)
      .flatMap((word) => [word, word.replace(/_/g, '-'), word.replace(/-/g, '_')])
      .filter((word) => word.length > 2)
  )];

  const countOccurrences = (content: string, word: string, max: number): number => {
    let count = 0;
    let offset = 0;
    while (count < max) {
      const match = content.indexOf(word, offset);
      if (match === -1) break;
      count++;
      offset = match + word.length;
    }
    return count;
  };

  // Score each document
  const scored = docsIndex
    .filter((doc) => {
      // Version-independent organization/community material participates in every
      // search; protocol docs and schemas must match the selected release.
      if (doc.version && doc.version !== selectedVersion.version) {
        return false;
      }
      // Filter by category if specified
      if (options.category && doc.category.toLowerCase() !== options.category.toLowerCase()) {
        return false;
      }
      return true;
    })
    .map((doc) => {
      const titleLower = doc.title.toLowerCase();
      const contentLower = doc.content.toLowerCase();
      const identityLower = `${doc.id} ${doc.path}`.toLowerCase();

      let score = 0;

      // Exact query match in title (highest weight)
      if (titleLower.includes(queryLower)) {
        score += 100;
      }

      // Exact query match in content
      if (contentLower.includes(queryLower)) {
        score += 50;
      }

      // Schema/task names often arrive as snake_case while filenames use
      // kebab-case. Stable IDs and paths provide the bridge between them.
      if (identityLower.includes(queryLower.replace(/_/g, '-'))) {
        score += 75;
      }

      // Individual word matches
      for (const word of queryWords) {
        if (titleLower.includes(word)) {
          score += 20;
        }
        if (identityLower.includes(word)) {
          score += 15;
        }
        // Count occurrences in content (limited to avoid huge scores)
        const occurrences = countOccurrences(contentLower, word, 10);
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
 * Get a doc by ID.
 * Accepts the canonical ID (e.g. "doc:media-buy/advanced-topics/targeting")
 * or a bare path without the prefix (e.g. "media-buy/advanced-topics/targeting").
 */
export function getDocById(id: string, options: { version?: string } = {}): IndexedDoc | null {
  const selectedVersion = resolveDocsVersion(options.version);
  if (!selectedVersion) return null;

  const isAvailable = (doc: IndexedDoc): boolean => (
    !doc.version || doc.version === selectedVersion.version
  );
  const exact = docsIndex.find((doc) => doc.id === id);
  // A canonical versioned ID is self-scoping. An explicit version argument,
  // when supplied, still guards against accidental cross-version retrieval.
  if (exact && (!options.version || isAvailable(exact))) return exact;

  const normalizedPath = id
    .replace(/^doc:/, '')
    .replace(/^schema:/, '')
    .replace(/\.json$/, '');
  const candidates = [
    `doc:${selectedVersion.version}:${normalizedPath}`,
    `schema:${selectedVersion.version}:${normalizedPath}`,
    `doc:${id}`,
    `website:${id}`,
    `wg-doc:${id}`,
  ];

  return docsIndex.find((doc) => candidates.includes(doc.id) && isAvailable(doc)) || null;
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
  options: { docId?: string; limit?: number; version?: string } = {}
): IndexedHeading[] {
  if (!initialized || headingsIndex.length === 0) {
    return [];
  }

  const limit = options.limit ?? 5;
  const selectedVersion = resolveDocsVersion(options.version);
  if (!selectedVersion) return [];
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2);

  // Score each heading
  const scored = headingsIndex
    .filter((heading) => {
      const parentDoc = docsIndex.find((doc) => doc.id === heading.doc_id);
      if (parentDoc?.version && parentDoc.version !== selectedVersion.version) {
        return false;
      }
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

/**
 * Load working group documents from the database into the in-memory index.
 * Documents are categorized by their working group name so they're
 * naturally filterable alongside other doc categories.
 */
async function loadWorkingGroupDocuments(): Promise<IndexedDoc[]> {
  const workingGroupDb = new WorkingGroupDatabase();
  const documents = await workingGroupDb.getIndexedDocumentsWithContent();
  const indexed: IndexedDoc[] = [];

  for (const doc of documents) {
    const id = `wg-doc:${doc.working_group_slug}/${doc.id}`;
    const category = `working group: ${doc.working_group_name.toLowerCase()}`;
    let content = doc.last_content || '';

    // Append asset descriptions so visual content is searchable
    try {
      const assets = await workingGroupDb.getDocumentAssets(doc.id, doc.working_group_id);
      const described = assets.filter(a => a.description);
      if (described.length > 0) {
        const assetSection = described
          .map(a => `[Image: ${a.description}] (${process.env.BASE_URL || ''}/api/working-groups/assets/${a.id})`)
          .join('\n');
        content += `\n\n## Visual Assets\n${assetSection}`;
      }
    } catch {
      // Asset descriptions are supplementary — don't fail the whole doc
    }

    indexed.push({
      id,
      title: doc.title,
      category,
      path: `working-groups/${doc.working_group_slug}/${doc.id}`,
      content,
      sourceUrl: doc.document_url || `/api/working-groups/${doc.working_group_slug}/documents/${doc.id}/file`,
    });
  }

  return indexed;
}

/**
 * Load published perspectives from the database into the in-memory index.
 * Perspectives include articles, white papers, and reports authored by
 * members or the AAO itself.
 */
async function loadPublishedPerspectives(): Promise<IndexedDoc[]> {
  const { query: dbQuery } = await import('../../db/client.js');
  const result = await dbQuery<{
    slug: string;
    title: string;
    content: string | null;
    excerpt: string | null;
    author_name: string | null;
    category: string | null;
    content_origin: string | null;
  }>(
    `SELECT slug, title, content, excerpt, author_name, category, content_origin
     FROM perspectives
     WHERE status = 'published'
       AND is_members_only = false
       AND content_type = 'article'
       AND content IS NOT NULL
     ORDER BY published_at DESC`
  );

  return result.rows.map((row) => {
    let body = row.content || '';
    if (row.author_name) {
      body = `By ${row.author_name}.\n\n${body}`;
    }
    if (row.excerpt && !body.startsWith(row.excerpt)) {
      body = `${row.excerpt}\n\n${body}`;
    }

    return {
      id: `perspective:${row.slug}`,
      title: row.title,
      category: 'perspective',
      path: `perspectives/${row.slug}`,
      content: cleanContent(body),
      sourceUrl: `${process.env.BASE_URL || 'https://agenticadvertising.org'}/perspectives/${row.slug}`,
    };
  });
}

/**
 * Refresh working group documents in the in-memory index.
 * Called by the committee document indexer after processing changes.
 * Removes stale entries and reloads from the database.
 */
export async function refreshWorkingGroupDocs(): Promise<void> {
  if (!initialized) return;

  try {
    const workingGroupDocs = await loadWorkingGroupDocuments();
    const nonWgDocs = docsIndex.filter((doc) => !doc.id.startsWith('wg-doc:'));
    docsIndex = [...nonWgDocs, ...workingGroupDocs];
    docsCorpusFingerprint = computeDocsCorpusFingerprint();
    logger.info({ count: workingGroupDocs.length }, 'Addie Docs: Refreshed working group documents');
  } catch (error) {
    logger.warn({ error }, 'Addie Docs: Failed to refresh working group documents');
  }
}
