/**
 * External Repository Indexer for Addie
 *
 * Clones/pulls external GitHub repositories at startup and indexes their
 * documentation (README, docs/, etc.) so Addie can answer questions about them.
 *
 * Repos are cached locally in a .addie-repos directory and updated on each startup.
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { logger } from '../../logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ExternalRepo {
  /** Unique identifier for this repo */
  id: string;
  /** GitHub repository URL */
  url: string;
  /** Human-readable name */
  name: string;
  /** Description of what this repo contains */
  description: string;
  /** Patterns to index (relative to repo root) */
  indexPatterns?: string[];
  /** Branch to clone (defaults to main) */
  branch?: string;
}

export interface IndexedExternalDoc {
  id: string;
  repoId: string;
  repoName: string;
  title: string;
  path: string;
  content: string;
  sourceUrl: string;
}

/**
 * Indexed heading from external repo - a section within a doc, searchable by itself
 * Enables finding specific protocol details buried in larger spec documents
 */
export interface IndexedExternalHeading {
  id: string;              // e.g., "external:iab-gpp:Core/Consent String Specification#string-format"
  doc_id: string;          // parent doc ID
  repoId: string;
  repoName: string;
  anchor: string;          // e.g., "string-format"
  title: string;           // heading text
  level: number;           // 2, 3 (skip level 1 - doc title)
  parent_headings: string[]; // breadcrumb: ["Consent String Specification", "String Format"]
  content: string;         // content under this heading
  sourceUrl: string;       // with anchor: ".../spec.md#string-format"
  path: string;            // file path within repo
}

/**
 * External repositories to index.
 * Add new repos here to make them available to Addie.
 *
 * These repos are pre-cloned at Docker build time (see Dockerfile)
 * and updated on each server startup.
 */
const EXTERNAL_REPOS: ExternalRepo[] = [
  // ============================================
  // AdCP Ecosystem (CORE)
  // ============================================
  {
    id: 'adcp',
    url: 'https://github.com/adcontextprotocol/adcp',
    name: 'AdCP Protocol',
    description: 'The Ad Context Protocol - core specification, docs, and schemas',
    indexPatterns: ['README.md', 'docs/**/*.md', 'docs/**/*.mdx', 'CHANGELOG.md'],
    branch: 'main',
  },
  {
    id: 'salesagent',
    url: 'https://github.com/adcontextprotocol/salesagent',
    name: 'AdCP Sales Agent',
    description: 'Reference implementation of an AdCP sales agent for publishers',
    indexPatterns: ['README.md', 'docs/**/*.md', 'CHANGELOG.md'],
    branch: 'main',
  },
  {
    id: 'signals-agent',
    url: 'https://github.com/adcontextprotocol/signals-agent',
    name: 'AdCP Signals Agent',
    description: 'Reference implementation of an AdCP Signals Agent',
    indexPatterns: ['README.md', 'docs/**/*.md', 'CHANGELOG.md'],
    branch: 'main',
  },
  {
    id: 'adcp-client',
    url: 'https://github.com/adcontextprotocol/adcp-client',
    name: 'AdCP JavaScript Client',
    description: 'Official JavaScript/TypeScript client library for AdCP',
    indexPatterns: ['README.md', 'docs/**/*.md', 'CHANGELOG.md'],
    branch: 'main',
  },
  {
    id: 'adcp-client-python',
    url: 'https://github.com/adcontextprotocol/adcp-client-python',
    name: 'AdCP Python Client',
    description: 'Official Python client library for AdCP',
    indexPatterns: ['README.md', 'docs/**/*.md', 'CHANGELOG.md'],
    branch: 'main',
  },

  // ============================================
  // Agent Protocols - A2A
  // ============================================
  {
    id: 'a2a',
    url: 'https://github.com/a2aproject/A2A',
    name: 'Google A2A Protocol',
    description: 'Agent-to-Agent protocol for AI agent interoperability (Google/Linux Foundation)',
    indexPatterns: ['README.md', 'docs/**/*.md', 'spec/**/*.md', '*.md'],
    branch: 'main',
  },
  {
    id: 'a2a-samples',
    url: 'https://github.com/a2aproject/a2a-samples',
    name: 'A2A Samples',
    description: 'Sample code demonstrating A2A protocol mechanics',
    indexPatterns: ['README.md', '**/*.md'],
    branch: 'main',
  },

  // ============================================
  // Agent Protocols - MCP
  // ============================================
  {
    id: 'mcp-spec',
    url: 'https://github.com/modelcontextprotocol/modelcontextprotocol',
    name: 'MCP Specification',
    description: 'Model Context Protocol specification from Anthropic',
    indexPatterns: ['README.md', 'docs/**/*.md', 'spec/**/*.md', '*.md'],
    branch: 'main',
  },
  {
    id: 'mcp-typescript-sdk',
    url: 'https://github.com/modelcontextprotocol/typescript-sdk',
    name: 'MCP TypeScript SDK',
    description: 'Official TypeScript SDK for building MCP servers and clients',
    indexPatterns: ['README.md', 'docs/**/*.md', '*.md'],
    branch: 'main',
  },
  {
    id: 'mcp-python-sdk',
    url: 'https://github.com/modelcontextprotocol/python-sdk',
    name: 'MCP Python SDK',
    description: 'Official Python SDK for building MCP servers and clients',
    indexPatterns: ['README.md', 'docs/**/*.md', '*.md'],
    branch: 'main',
  },
  {
    id: 'mcp-servers',
    url: 'https://github.com/modelcontextprotocol/servers',
    name: 'MCP Reference Servers',
    description: 'Reference MCP server implementations',
    indexPatterns: ['README.md', 'src/**/*.md', '*.md'],
    branch: 'main',
  },

  // ============================================
  // IAB Tech Lab - Agentic Advertising
  // ============================================
  {
    id: 'iab-artf',
    url: 'https://github.com/IABTechLab/agentic-rtb-framework',
    name: 'IAB ARTF',
    description: 'Agentic RTB Framework - containerized architecture for agentic ad trading',
    indexPatterns: ['README.md', 'docs/**/*.md', 'spec/**/*.md', '*.md'],
    branch: 'main',
  },
  {
    id: 'iab-ucp',
    url: 'https://github.com/IABTechLab/user-context-protocol',
    name: 'IAB UCP',
    description: 'User Context Protocol - agent context exchange (identity, contextual, reinforcement)',
    indexPatterns: ['README.md', 'docs/**/*.md', 'spec/**/*.md', '*.md'],
    branch: 'main',
  },

  // ============================================
  // IAB Tech Lab - OpenMedia Stack
  // ============================================
  {
    id: 'iab-openrtb2',
    url: 'https://github.com/InteractiveAdvertisingBureau/openrtb2.x',
    name: 'OpenRTB 2.x',
    description: 'OpenRTB 2.6+ real-time bidding specification (production standard)',
    indexPatterns: ['README.md', '*.md', 'extensions/**/*.md'],
    branch: 'main',
  },
  {
    id: 'iab-openrtb3',
    url: 'https://github.com/InteractiveAdvertisingBureau/openrtb',
    name: 'OpenRTB 3.0',
    description: 'OpenRTB 3.0 specification with layered architecture',
    indexPatterns: ['README.md', '*.md', 'specification/**/*.md'],
    branch: 'main',
  },
  {
    id: 'iab-adcom',
    url: 'https://github.com/InteractiveAdvertisingBureau/AdCOM',
    name: 'IAB AdCOM',
    description: 'Advertising Common Object Model - domain objects for ads, placements, users',
    indexPatterns: ['README.md', '*.md', 'specification/**/*.md'],
    branch: 'main',
  },
  {
    id: 'iab-opendirect',
    url: 'https://github.com/InteractiveAdvertisingBureau/OpenDirect',
    name: 'IAB OpenDirect',
    description: 'Automated Guaranteed buying specification for direct sales',
    indexPatterns: ['README.md', '*.md', 'specification/**/*.md'],
    branch: 'main',
  },

  // ============================================
  // IAB Tech Lab - Privacy & Consent
  // ============================================
  {
    id: 'iab-gpp',
    url: 'https://github.com/InteractiveAdvertisingBureau/Global-Privacy-Platform',
    name: 'IAB GPP',
    description: 'Global Privacy Platform - consent signaling (TCF, MSPA, US State strings)',
    indexPatterns: ['README.md', '*.md', 'Core/**/*.md', 'Sections/**/*.md'],
    branch: 'main',
  },
  {
    id: 'iab-tcf',
    url: 'https://github.com/InteractiveAdvertisingBureau/GDPR-Transparency-and-Consent-Framework',
    name: 'IAB TCF',
    description: 'Transparency and Consent Framework technical specs for GDPR compliance',
    indexPatterns: ['README.md', '*.md', 'TCFv2/**/*.md'],
    branch: 'master',
  },
  {
    id: 'iab-usprivacy',
    url: 'https://github.com/InteractiveAdvertisingBureau/USPrivacy',
    name: 'IAB US Privacy',
    description: 'US Privacy technical specifications (CCPA compliance)',
    indexPatterns: ['README.md', '*.md'],
    branch: 'master',
  },

  // ============================================
  // IAB Tech Lab - Identity
  // ============================================
  {
    id: 'iab-uid2-docs',
    url: 'https://github.com/IABTechLab/uid2docs',
    name: 'UID2 Documentation',
    description: 'Unified ID 2.0 documentation - privacy-safe identity solution',
    indexPatterns: ['README.md', 'docs/**/*.md', '*.md'],
    branch: 'main',
  },

  // ============================================
  // IAB Tech Lab - Video & Security
  // ============================================
  {
    id: 'iab-vast',
    url: 'https://github.com/InteractiveAdvertisingBureau/vast',
    name: 'IAB VAST',
    description: 'Video Ad Serving Template - XML schema for video ad serving',
    indexPatterns: ['README.md', '*.md', 'docs/**/*.md'],
    branch: 'master',
  },
  {
    id: 'iab-adscert',
    url: 'https://github.com/IABTechLab/adscert',
    name: 'IAB ads.cert',
    description: 'ads.cert 2.0 authenticated connections protocol for supply chain security',
    indexPatterns: ['README.md', '*.md', 'docs/**/*.md'],
    branch: 'main',
  },

  // ============================================
  // Prebid Ecosystem
  // ============================================
  {
    id: 'prebid-js',
    url: 'https://github.com/prebid/Prebid.js',
    name: 'Prebid.js',
    description: 'Client-side header bidding library with 200+ bid adapters',
    indexPatterns: ['README.md', 'CONTRIBUTING.md', 'modules/**/*.md'],
    branch: 'master',
  },
  {
    id: 'prebid-server',
    url: 'https://github.com/prebid/prebid-server',
    name: 'Prebid Server',
    description: 'Server-side header bidding for mobile, AMP, CTV, DOOH',
    indexPatterns: ['README.md', 'docs/**/*.md'],
    branch: 'master',
  },
  {
    id: 'prebid-docs',
    url: 'https://github.com/prebid/prebid.github.io',
    name: 'Prebid Documentation',
    description: 'Official Prebid documentation site - configuration guides, bidder adapters, ad ops workflows, GAM integration, troubleshooting, Prebid Server, Prebid Mobile, and video',
    indexPatterns: ['**/*.md'],
    branch: 'master',
  },

  // ============================================
  // Agent Frameworks (for reference)
  // ============================================
  {
    id: 'langgraph',
    url: 'https://github.com/langchain-ai/langgraph',
    name: 'LangGraph',
    description: 'Framework for building controllable agent workflows',
    indexPatterns: ['README.md', 'docs/**/*.md'],
    branch: 'main',
  },
];

// In-memory index of external docs and headings
let externalDocsIndex: IndexedExternalDoc[] = [];
let externalHeadingsIndex: IndexedExternalHeading[] = [];
let initialized = false;

// Directory where repos are cached
let reposDir: string;

/**
 * Get the repos cache directory
 */
function getReposDir(): string {
  if (reposDir) return reposDir;

  // Try to find a suitable location
  const possiblePaths = [
    // From server/src/addie/mcp/ to project root
    path.resolve(__dirname, '../../../../.addie-repos'),
    // From dist/ to project root
    path.resolve(__dirname, '../../../.addie-repos'),
    // Docker location
    '/app/.addie-repos',
    // Fallback to temp
    path.join(process.env.TMPDIR || '/tmp', 'addie-repos'),
  ];

  // Use the first path that exists or can be created
  for (const p of possiblePaths) {
    try {
      if (!fs.existsSync(p)) {
        fs.mkdirSync(p, { recursive: true });
      }
      reposDir = p;
      return reposDir;
    } catch {
      continue;
    }
  }

  // Final fallback
  reposDir = possiblePaths[possiblePaths.length - 1];
  fs.mkdirSync(reposDir, { recursive: true });
  return reposDir;
}

/**
 * Clone or update a repository
 */
function syncRepo(repo: ExternalRepo): string | null {
  const repoPath = path.join(getReposDir(), repo.id);
  const branch = repo.branch || 'main';

  try {
    if (fs.existsSync(path.join(repoPath, '.git'))) {
      // Repo exists, pull latest
      logger.debug({ repoId: repo.id }, 'Addie External Repos: Pulling latest');
      execSync(`git -C "${repoPath}" fetch origin ${branch} --depth=1 2>/dev/null`, {
        timeout: 30000,
        stdio: 'pipe',
      });
      execSync(`git -C "${repoPath}" reset --hard origin/${branch} 2>/dev/null`, {
        timeout: 10000,
        stdio: 'pipe',
      });
    } else {
      // Clone fresh (shallow clone for speed)
      logger.info({ repoId: repo.id, url: repo.url }, 'Addie External Repos: Cloning');
      execSync(
        `git clone --depth=1 --branch ${branch} "${repo.url}" "${repoPath}" 2>/dev/null`,
        {
          timeout: 60000,
          stdio: 'pipe',
        }
      );
    }
    return repoPath;
  } catch (error) {
    logger.warn(
      { repoId: repo.id, error: error instanceof Error ? error.message : 'Unknown error' },
      'Addie External Repos: Failed to sync repo'
    );
    // If we have an existing clone, use it even if pull failed
    if (fs.existsSync(path.join(repoPath, '.git'))) {
      logger.info({ repoId: repo.id }, 'Addie External Repos: Using cached version');
      return repoPath;
    }
    return null;
  }
}

/**
 * Find files matching glob patterns in a directory
 * Simple implementation without glob library dependency
 */
function findMatchingFiles(baseDir: string, patterns: string[]): string[] {
  const files: string[] = [];

  for (const pattern of patterns) {
    if (pattern.includes('**')) {
      // Recursive pattern like 'docs/**/*.md'
      const [prefix, suffix] = pattern.split('**');
      const searchDir = path.join(baseDir, prefix.replace(/\/$/, ''));
      if (fs.existsSync(searchDir)) {
        findFilesRecursive(searchDir, suffix.replace(/^\//, ''), files);
      }
    } else if (pattern.includes('*')) {
      // Simple glob like '*.md'
      const dir = path.dirname(pattern);
      const filePattern = path.basename(pattern);
      const searchDir = dir === '.' ? baseDir : path.join(baseDir, dir);
      if (fs.existsSync(searchDir)) {
        const entries = fs.readdirSync(searchDir);
        for (const entry of entries) {
          if (matchesPattern(entry, filePattern)) {
            files.push(path.join(searchDir, entry));
          }
        }
      }
    } else {
      // Exact file like 'README.md'
      const filePath = path.join(baseDir, pattern);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        files.push(filePath);
      }
    }
  }

  return files;
}

function findFilesRecursive(dir: string, suffix: string, files: string[]): void {
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
        findFilesRecursive(fullPath, suffix, files);
      }
    } else if (entry.isFile()) {
      if (matchesPattern(entry.name, suffix)) {
        files.push(fullPath);
      }
    }
  }
}

function matchesPattern(filename: string, pattern: string): boolean {
  if (pattern === '*') return true;
  if (pattern.startsWith('*.')) {
    return filename.endsWith(pattern.slice(1));
  }
  return filename === pattern;
}

/**
 * Extract title from markdown content
 */
function extractTitle(content: string, filename: string): string {
  // Try frontmatter
  const frontmatterMatch = content.match(/^---\s*\n[\s\S]*?title:\s*["']?([^"'\n]+)["']?\s*\n[\s\S]*?---/);
  if (frontmatterMatch) {
    return frontmatterMatch[1].trim();
  }

  // Try first heading
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
 * Generate a URL-safe anchor slug from heading text
 * Follows GitHub/Mintlify conventions for heading anchors
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
 * Used to enable section-level search in external specs
 */
function extractHeadings(
  content: string,
  docId: string,
  docTitle: string,
  baseUrl: string,
  repoId: string,
  repoName: string,
  filePath: string
): IndexedExternalHeading[] {
  const headings: IndexedExternalHeading[] = [];
  const lines = content.split('\n');

  // Track the parent heading stack for breadcrumbs
  const parentStack: Array<{ level: number; title: string }> = [];

  // Track seen anchors to handle duplicates (matching GitHub's behavior)
  const seenAnchors = new Map<string, number>();

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
            repoId,
            repoName,
            anchor: currentHeading.anchor,
            title: currentHeading.title,
            level: currentHeading.level,
            parent_headings: currentHeading.parentHeadings,
            content: headingContent,
            sourceUrl: `${baseUrl}#${currentHeading.anchor}`,
            path: filePath,
          });
        }
      }

      const level = headingMatch[1].length;
      const title = headingMatch[2].trim();
      const baseAnchor = slugify(title);

      // Handle duplicate anchors by appending a counter (matching GitHub's behavior)
      const count = seenAnchors.get(baseAnchor) || 0;
      const anchor = count > 0 ? `${baseAnchor}-${count}` : baseAnchor;
      seenAnchors.set(baseAnchor, count + 1);

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
        repoId,
        repoName,
        anchor: currentHeading.anchor,
        title: currentHeading.title,
        level: currentHeading.level,
        parent_headings: currentHeading.parentHeadings,
        content: headingContent,
        sourceUrl: `${baseUrl}#${currentHeading.anchor}`,
        path: filePath,
      });
    }
  }

  return headings;
}

/**
 * Clean markdown content
 */
function cleanContent(content: string): string {
  // Remove frontmatter
  content = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n/, '');

  // Remove import statements
  content = content.replace(/^import\s+.*$/gm, '');

  // Clean up extra whitespace
  content = content.replace(/\n{3,}/g, '\n\n').trim();

  return content;
}

/**
 * Build GitHub source URL for a file
 */
function buildSourceUrl(repo: ExternalRepo, relativePath: string): string {
  const branch = repo.branch || 'main';
  // Convert SSH URL to HTTPS if needed
  const httpsUrl = repo.url
    .replace('git@github.com:', 'https://github.com/')
    .replace(/\.git$/, '');
  return `${httpsUrl}/blob/${branch}/${relativePath}`;
}

/**
 * Index a single repository - returns both docs and headings
 */
function indexRepo(
  repo: ExternalRepo,
  repoPath: string
): { docs: IndexedExternalDoc[]; headings: IndexedExternalHeading[] } {
  const docs: IndexedExternalDoc[] = [];
  const headings: IndexedExternalHeading[] = [];
  const patterns = repo.indexPatterns || ['README.md', 'docs/**/*.md'];

  const files = findMatchingFiles(repoPath, patterns);

  for (const filePath of files) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const relativePath = path.relative(repoPath, filePath);
      const filename = path.basename(filePath);
      const title = extractTitle(content, filename);
      const cleanedContent = cleanContent(content);

      // Skip empty or very short files
      if (cleanedContent.length < 50) {
        continue;
      }

      const docId = `external:${repo.id}:${relativePath.replace(/\\/g, '/').replace(/\.(md|mdx)$/, '')}`;
      const sourceUrl = buildSourceUrl(repo, relativePath);

      docs.push({
        id: docId,
        repoId: repo.id,
        repoName: repo.name,
        title,
        path: relativePath,
        content: cleanedContent,
        sourceUrl,
      });

      // Extract headings for section-level search
      const docHeadings = extractHeadings(
        cleanedContent,
        docId,
        title,
        sourceUrl,
        repo.id,
        repo.name,
        relativePath
      );
      headings.push(...docHeadings);
    } catch (error) {
      logger.warn({ repoId: repo.id, filePath, error }, 'Addie External Repos: Failed to index file');
    }
  }

  return { docs, headings };
}

/**
 * Initialize the external repos indexer
 * Call this at startup to clone/update repos and build the index
 */
export async function initializeExternalRepos(): Promise<void> {
  if (initialized) {
    logger.debug('Addie External Repos: Already initialized');
    return;
  }

  // Check if git is available
  try {
    execSync('git --version', { stdio: 'pipe' });
  } catch {
    logger.warn('Addie External Repos: Git not available, skipping external repo indexing');
    initialized = true;
    return;
  }

  logger.info({ repoCount: EXTERNAL_REPOS.length }, 'Addie External Repos: Syncing repositories');

  externalDocsIndex = [];
  externalHeadingsIndex = [];

  for (const repo of EXTERNAL_REPOS) {
    const repoPath = syncRepo(repo);
    if (repoPath) {
      const { docs, headings } = indexRepo(repo, repoPath);
      externalDocsIndex.push(...docs);
      externalHeadingsIndex.push(...headings);
    }
  }

  initialized = true;
  logger.info(
    {
      totalDocs: externalDocsIndex.length,
      totalHeadings: externalHeadingsIndex.length,
      repos: EXTERNAL_REPOS.map((r) => r.id).join(', '),
    },
    'Addie External Repos: Indexing complete'
  );
}

/**
 * Check if external repos index is ready
 */
export function isExternalReposReady(): boolean {
  return initialized;
}

/**
 * Synonyms for common search terms to improve recall.
 * Maps query terms to related terms that should also be searched.
 */
const SEARCH_SYNONYMS: Record<string, string[]> = {
  setup: ['quickstart', 'install', 'getting started', 'configure', 'deployment'],
  install: ['setup', 'quickstart', 'getting started'],
  start: ['quickstart', 'getting started', 'setup'],
  deploy: ['deployment', 'hosting', 'cloud', 'production'],
  config: ['configure', 'configuration', 'environment', 'settings'],
  run: ['start', 'execute', 'launch'],
  // Prebid ecosystem
  prebid: ['header bidding', 'prebid.js', 'prebid server', 'pbs', 'pbjs'],
  'header bidding': ['prebid', 'prebid.js'],
  bidder: ['adapter', 'bid adapter', 'demand partner'],
  adapter: ['bidder', 'bid adapter'],
  gam: ['google ad manager', 'dfp', 'ad server'],
  dfp: ['gam', 'google ad manager'],
  gdpr: ['tcf', 'consent', 'cmp'],
  consent: ['gdpr', 'tcf', 'cmp', 'gpp'],
  floors: ['price floors', 'floor price', 'bid floor'],
  'price floors': ['floors', 'floor price', 'bid floor'],
  currency: ['currency conversion', 'currency module'],
  'user id': ['identity', 'userid', 'uid2', 'id module'],
  video: ['video ads', 'outstream', 'instream', 'vast'],
  pbjs: ['prebid.js', 'prebid'],
  pbs: ['prebid server', 'server-side bidding'],
};

/**
 * Paths that indicate "getting started" documentation - boost these for setup queries
 */
const GETTING_STARTED_PATTERNS = ['quickstart', 'readme', 'index', 'getting-started', 'installation'];

/**
 * Check if a query is asking about getting started / setup
 */
function isGettingStartedQuery(queryLower: string): boolean {
  const gettingStartedTerms = [
    'setup',
    'install',
    'start',
    'getting started',
    'quickstart',
    'begin',
    'deploy',
    'run',
    'how to',
    'how do i',
  ];
  return gettingStartedTerms.some((term) => queryLower.includes(term));
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Search external repos documentation
 */
export function searchExternalDocs(
  query: string,
  options: { repoId?: string; limit?: number } = {}
): IndexedExternalDoc[] {
  if (!initialized || externalDocsIndex.length === 0) {
    return [];
  }

  const limit = options.limit ?? 5;
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2);

  // Expand query words with synonyms
  const expandedWords = new Set(queryWords);
  for (const word of queryWords) {
    const synonyms = SEARCH_SYNONYMS[word];
    if (synonyms) {
      synonyms.forEach((syn) => expandedWords.add(syn));
    }
  }

  const isGettingStarted = isGettingStartedQuery(queryLower);

  // Score each document
  const scored = externalDocsIndex
    .filter((doc) => {
      // Filter by repo if specified
      if (options.repoId && doc.repoId !== options.repoId) {
        return false;
      }
      return true;
    })
    .map((doc) => {
      const titleLower = doc.title.toLowerCase();
      const contentLower = doc.content.toLowerCase();
      const pathLower = doc.path.toLowerCase();

      let score = 0;

      // Exact query match in title (highest weight)
      if (titleLower.includes(queryLower)) {
        score += 100;
      }

      // Exact query match in content
      if (contentLower.includes(queryLower)) {
        score += 50;
      }

      // Individual word matches (including synonyms)
      for (const word of expandedWords) {
        if (titleLower.includes(word)) {
          score += 20;
        }
        // Count occurrences in content (limited to avoid huge scores)
        const escapedWord = escapeRegex(word);
        const occurrences = Math.min((contentLower.match(new RegExp(escapedWord, 'g')) || []).length, 10);
        score += occurrences * 2;
      }

      // Boost "getting started" docs for setup-related queries
      if (isGettingStarted) {
        const isGettingStartedDoc = GETTING_STARTED_PATTERNS.some(
          (pattern) => pathLower.includes(pattern) || titleLower.includes(pattern)
        );
        if (isGettingStartedDoc) {
          score += 30;
        }
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
 * Search external repos at heading/section level
 * Better for finding specific protocol details buried in larger spec documents
 */
export function searchExternalHeadings(
  query: string,
  options: { repoId?: string; limit?: number } = {}
): IndexedExternalHeading[] {
  if (!initialized || externalHeadingsIndex.length === 0) {
    return [];
  }

  const limit = options.limit ?? 5;
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2);

  // Expand query words with synonyms
  const expandedWords = new Set(queryWords);
  for (const word of queryWords) {
    const synonyms = SEARCH_SYNONYMS[word];
    if (synonyms) {
      synonyms.forEach((syn) => expandedWords.add(syn));
    }
  }

  // Pre-compile regexes for expanded words (avoid creating 36,785 regexes per search)
  const wordPatterns = Array.from(expandedWords).map((word) => ({
    word,
    regex: new RegExp(escapeRegex(word), 'g'),
  }));

  // Score each heading
  const scored = externalHeadingsIndex
    .filter((heading) => {
      // Filter by repo if specified
      if (options.repoId && heading.repoId !== options.repoId) {
        return false;
      }
      return true;
    })
    .map((heading) => {
      const titleLower = heading.title.toLowerCase();
      const contentLower = heading.content.toLowerCase();
      const breadcrumbLower = heading.parent_headings.join(' ').toLowerCase();

      let score = 0;

      // Exact query match in heading title (highest weight)
      if (titleLower.includes(queryLower)) {
        score += 150;
      }

      // Exact title match (bonus)
      if (titleLower === queryLower) {
        score += 100;
      }

      // Match in parent headings (breadcrumb context)
      if (breadcrumbLower.includes(queryLower)) {
        score += 40;
      }

      // Exact query match in content
      if (contentLower.includes(queryLower)) {
        score += 30;
      }

      // Individual word matches (including synonyms)
      for (const { word, regex } of wordPatterns) {
        if (titleLower.includes(word)) {
          score += 25;
        }
        if (breadcrumbLower.includes(word)) {
          score += 10;
        }
        // Count occurrences in content (limited to avoid huge scores)
        regex.lastIndex = 0; // Reset regex since we're reusing
        const occurrences = Math.min((contentLower.match(regex) || []).length, 5);
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
 * Get total heading count for external repos
 */
export function getExternalHeadingCount(): number {
  return externalHeadingsIndex.length;
}

/**
 * Get all indexed external repos with doc and heading counts
 */
export function getExternalRepoStats(): Array<{ id: string; name: string; docCount: number; headingCount: number }> {
  const docCounts = new Map<string, number>();
  const headingCounts = new Map<string, number>();
  const names = new Map<string, string>();

  for (const doc of externalDocsIndex) {
    docCounts.set(doc.repoId, (docCounts.get(doc.repoId) || 0) + 1);
    names.set(doc.repoId, doc.repoName);
  }

  for (const heading of externalHeadingsIndex) {
    headingCounts.set(heading.repoId, (headingCounts.get(heading.repoId) || 0) + 1);
  }

  return Array.from(docCounts.entries()).map(([id, count]) => ({
    id,
    name: names.get(id) || id,
    docCount: count,
    headingCount: headingCounts.get(id) || 0,
  }));
}

/**
 * Get the list of configured external repos
 */
export function getConfiguredRepos(): ExternalRepo[] {
  return [...EXTERNAL_REPOS];
}
